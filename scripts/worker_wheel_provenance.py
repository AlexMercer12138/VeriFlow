import base64
import csv
import email.parser
import hashlib
import importlib.metadata
import io
import json
import os
import re
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, Tuple
from urllib.parse import urlsplit
from urllib.request import url2pathname


WHEEL_PATH_ENV = "VERIFLOW_HDL_WORKER_WHEEL_PATH"
WHEEL_SHA256_ENV = "VERIFLOW_HDL_WORKER_WHEEL_SHA256"
EXPECTED_DISTRIBUTION = "veriflow-hdl-worker"
EXPECTED_VERSION = "1.3.2"
EXPECTED_WHEEL_NAME = "veriflow_hdl_worker-1.3.2-py3-none-win_amd64.whl"
DIST_INFO_ROOT = "veriflow_hdl_worker-1.3.2.dist-info/"
REQUIRED_MEMBERS = (
    "veriflow_hdl_worker/__init__.py",
    "veriflow_hdl_worker/runtime.py",
    "veriflow_hdl_worker/bin/parser-worker.exe",
    "veriflow_hdl_worker/bin/web-tree-sitter.wasm",
    "veriflow_hdl_worker/bin/tree-sitter-systemverilog.wasm",
    "veriflow_hdl_worker/bin/manifest.json",
    DIST_INFO_ROOT + "WHEEL",
    DIST_INFO_ROOT + "METADATA",
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _record_digest(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return "sha256=" + digest.decode("ascii")


def _normalized_sha256(value: str) -> str:
    if re.fullmatch(r"[0-9a-fA-F]{64}", value) is None:
        raise ValueError("Expected wheel SHA-256 must contain exactly 64 hex digits")
    return value.lower()


def _normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path.resolve(strict=False))))


def _file_url_path(url: str) -> Path:
    parsed = urlsplit(url)
    if parsed.scheme != "file" or parsed.query or parsed.fragment:
        raise ValueError(f"Installed worker source is not a local wheel file: {url!r}")
    if parsed.netloc not in ("", "localhost"):
        raise ValueError(f"Installed worker source uses an unsupported host: {url!r}")
    path_text = url2pathname(parsed.path)
    if os.name == "nt" and re.match(r"^[/\\][A-Za-z]:", path_text):
        path_text = path_text[1:]
    return Path(path_text)


def _read_record(archive: zipfile.ZipFile) -> Dict[str, Tuple[str, str]]:
    record_name = DIST_INFO_ROOT + "RECORD"
    if record_name not in archive.namelist():
        raise ValueError("Wheel is missing its expected RECORD")
    rows = csv.reader(io.StringIO(archive.read(record_name).decode("utf-8")))
    records: Dict[str, Tuple[str, str]] = {}
    for row in rows:
        if len(row) != 3 or row[0] in records:
            raise ValueError("Wheel RECORD contains an invalid or duplicate row")
        records[row[0]] = (row[1], row[2])
    return records


def _validate_wheel_identity(archive: zipfile.ZipFile) -> None:
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise ValueError("Wheel contains duplicate archive members")
    missing = [name for name in REQUIRED_MEMBERS if name not in names]
    if missing:
        raise ValueError(f"Wheel is missing required members: {missing}")

    wheel_text = archive.read(DIST_INFO_ROOT + "WHEEL").decode("utf-8")
    tags = [line for line in wheel_text.splitlines() if line.startswith("Tag: ")]
    if tags != ["Tag: py3-none-win_amd64"]:
        raise ValueError(f"Unexpected wheel tag: {tags}")

    metadata = email.parser.Parser().parsestr(
        archive.read(DIST_INFO_ROOT + "METADATA").decode("utf-8")
    )
    if (
        metadata.get("Name") != EXPECTED_DISTRIBUTION
        or metadata.get("Version") != EXPECTED_VERSION
    ):
        raise ValueError(
            "Wheel METADATA must identify veriflow-hdl-worker version 1.3.2"
        )


def _validate_install_source(
    distribution: importlib.metadata.Distribution,
    wheel_path: Path,
    expected_sha256: str,
) -> None:
    direct_url_text = distribution.read_text("direct_url.json")
    if not direct_url_text:
        raise ValueError("Installed worker source has no direct_url.json")
    try:
        direct_url = json.loads(direct_url_text)
        source_path = _file_url_path(direct_url["url"])
        source_sha256 = direct_url["archive_info"]["hashes"]["sha256"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Installed worker source metadata is incomplete") from error

    if _normalized_path(source_path) != _normalized_path(wheel_path):
        raise ValueError(
            f"Installed worker source does not match exact wheel: {source_path}"
        )
    if _normalized_sha256(source_sha256) != expected_sha256:
        raise ValueError("Installed worker source SHA-256 does not match exact wheel")


def _validate_installed_members(
    archive: zipfile.ZipFile,
    distribution: importlib.metadata.Distribution,
) -> None:
    records = _read_record(archive)
    install_root = Path(distribution.locate_file(PurePosixPath(""))).resolve()
    for name in REQUIRED_MEMBERS:
        wheel_data = archive.read(name)
        record = records.get(name)
        if record != (_record_digest(wheel_data), str(len(wheel_data))):
            raise ValueError(f"Wheel RECORD does not verify required member: {name}")

        installed_path = Path(
            distribution.locate_file(PurePosixPath(name))
        ).resolve(strict=False)
        try:
            installed_path.relative_to(install_root)
        except ValueError as error:
            raise ValueError(f"Installed worker file escapes package root: {name}") from error
        if not installed_path.is_file():
            raise ValueError(f"Installed worker file is missing: {name}")
        if (
            installed_path.stat().st_size != len(wheel_data)
            or _sha256_file(installed_path)
            != hashlib.sha256(wheel_data).hexdigest()
        ):
            raise ValueError(f"Installed worker file does not match wheel: {name}")


def verify_installed_worker_provenance(
    wheel_path: Path, expected_sha256: str
) -> None:
    expected_sha256 = _normalized_sha256(expected_sha256)
    wheel_path = Path(wheel_path).resolve(strict=False)
    if wheel_path.name != EXPECTED_WHEEL_NAME:
        raise ValueError(
            f"Unexpected worker wheel filename: {wheel_path.name}; "
            f"expected {EXPECTED_WHEEL_NAME}"
        )
    if not wheel_path.is_file():
        raise FileNotFoundError(f"Worker wheel does not exist: {wheel_path}")
    actual_sha256 = _sha256_file(wheel_path)
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"Worker wheel SHA-256 mismatch: expected {expected_sha256}, "
            f"found {actual_sha256}"
        )

    try:
        distribution = importlib.metadata.distribution(EXPECTED_DISTRIBUTION)
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimeError("veriflow-hdl-worker is not installed") from error
    if distribution.version != EXPECTED_VERSION:
        raise ValueError(
            f"Unexpected installed worker version: {distribution.version}; "
            f"expected {EXPECTED_VERSION}"
        )
    _validate_install_source(distribution, wheel_path, expected_sha256)

    with zipfile.ZipFile(wheel_path) as archive:
        _validate_wheel_identity(archive)
        _validate_installed_members(archive, distribution)


def verify_installed_worker_provenance_from_env() -> None:
    values = {}
    for name in (WHEEL_PATH_ENV, WHEEL_SHA256_ENV):
        value = os.environ.get(name)
        if not value:
            raise RuntimeError(f"Missing required environment variable: {name}")
        values[name] = value
    verify_installed_worker_provenance(
        Path(values[WHEEL_PATH_ENV]), values[WHEEL_SHA256_ENV]
    )

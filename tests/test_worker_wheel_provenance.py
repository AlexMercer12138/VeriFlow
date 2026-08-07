import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, Tuple

import pytest

from scripts import worker_wheel_provenance as provenance


WHEEL_PATH_ENV = "VERIFLOW_HDL_WORKER_WHEEL_PATH"
WHEEL_SHA256_ENV = "VERIFLOW_HDL_WORKER_WHEEL_SHA256"
WHEEL_NAME = "veriflow_hdl_worker-1.3.2-py3-none-win_amd64.whl"
DIST_INFO_ROOT = "veriflow_hdl_worker-1.3.2.dist-info"


class FakeDistribution:
    def __init__(self, root: Path, version: str = "1.3.2") -> None:
        self.root = root
        self.version = version

    def locate_file(self, path: PurePosixPath) -> Path:
        return self.root.joinpath(*PurePosixPath(path).parts)

    def read_text(self, filename: str) -> str:
        return (self.root / DIST_INFO_ROOT / filename).read_text(encoding="utf-8")


def _record_digest(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return "sha256=" + digest.decode("ascii")


def _write_wheel_and_installation(
    tmp_path: Path,
    *,
    tag: str = "py3-none-win_amd64",
    metadata_version: str = "1.3.2",
    installed_version: str = "1.3.2",
) -> Tuple[Path, str, FakeDistribution]:
    dist_info = DIST_INFO_ROOT + "/"
    entries: Dict[str, bytes] = {
        "veriflow_hdl_worker/__init__.py": b"package source",
        "veriflow_hdl_worker/runtime.py": b"runtime source",
        "veriflow_hdl_worker/bin/parser-worker.exe": b"worker executable",
        "veriflow_hdl_worker/bin/web-tree-sitter.wasm": b"runtime wasm",
        "veriflow_hdl_worker/bin/tree-sitter-systemverilog.wasm": b"language wasm",
        "veriflow_hdl_worker/bin/manifest.json": b'{"protocolVersion":1}',
        dist_info + "METADATA": (
            f"Name: veriflow-hdl-worker\nVersion: {metadata_version}\n"
        ).encode("utf-8"),
        dist_info + "WHEEL": (
            "Wheel-Version: 1.0\nRoot-Is-Purelib: false\n" f"Tag: {tag}\n"
        ).encode("utf-8"),
        dist_info + "top_level.txt": b"veriflow_hdl_worker\n",
    }
    record_name = dist_info + "RECORD"
    record_stream = io.StringIO(newline="")
    writer = csv.writer(record_stream, lineterminator="\n")
    for name, data in entries.items():
        writer.writerow([name, _record_digest(data), str(len(data))])
    writer.writerow([record_name, "", ""])
    entries[record_name] = record_stream.getvalue().encode("utf-8")

    wheel_path = tmp_path / WHEEL_NAME
    with zipfile.ZipFile(wheel_path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    wheel_sha256 = hashlib.sha256(wheel_path.read_bytes()).hexdigest()

    install_root = tmp_path / "site-packages"
    for name, data in entries.items():
        installed_path = install_root.joinpath(*PurePosixPath(name).parts)
        installed_path.parent.mkdir(parents=True, exist_ok=True)
        installed_path.write_bytes(data)
    direct_url = {
        "archive_info": {"hashes": {"sha256": wheel_sha256}},
        "url": wheel_path.resolve().as_uri(),
    }
    (install_root / DIST_INFO_ROOT / "direct_url.json").write_text(
        json.dumps(direct_url), encoding="utf-8"
    )
    return wheel_path, wheel_sha256, FakeDistribution(
        install_root, version=installed_version
    )


def _use_distribution(
    monkeypatch: pytest.MonkeyPatch, distribution: FakeDistribution
) -> None:
    monkeypatch.setattr(
        importlib.metadata, "distribution", lambda _name: distribution
    )


@pytest.mark.parametrize("missing_env", [WHEEL_PATH_ENV, WHEEL_SHA256_ENV])
def test_provenance_environment_requires_wheel_path_and_sha256(
    monkeypatch: pytest.MonkeyPatch, missing_env: str
) -> None:
    monkeypatch.setenv(WHEEL_PATH_ENV, "worker.whl")
    monkeypatch.setenv(WHEEL_SHA256_ENV, "0" * 64)
    monkeypatch.delenv(missing_env)

    with pytest.raises(RuntimeError, match=missing_env):
        provenance.verify_installed_worker_provenance_from_env()


def test_provenance_rejects_missing_wheel(tmp_path: Path) -> None:
    missing_wheel = tmp_path / WHEEL_NAME

    with pytest.raises(FileNotFoundError, match="wheel"):
        provenance.verify_installed_worker_provenance(missing_wheel, "0" * 64)


def test_provenance_rejects_wrong_wheel_sha256(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel_path, _wheel_sha256, distribution = _write_wheel_and_installation(tmp_path)
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match="SHA-256"):
        provenance.verify_installed_worker_provenance(wheel_path, "0" * 64)


def test_provenance_rejects_wrong_wheel_filename(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel_path, wheel_sha256, distribution = _write_wheel_and_installation(tmp_path)
    wrong_name = wheel_path.with_name("other-1.3.2-py3-none-win_amd64.whl")
    wheel_path.rename(wrong_name)
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match="filename"):
        provenance.verify_installed_worker_provenance(wrong_name, wheel_sha256)


@pytest.mark.parametrize(
    ("wheel_kwargs", "message"),
    [
        ({"tag": "py3-none-any"}, "tag"),
        ({"metadata_version": "9.9.9"}, "METADATA"),
    ],
)
def test_provenance_rejects_wrong_wheel_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    wheel_kwargs: Dict[str, str],
    message: str,
) -> None:
    wheel_path, wheel_sha256, distribution = _write_wheel_and_installation(
        tmp_path, **wheel_kwargs
    )
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match=message):
        provenance.verify_installed_worker_provenance(wheel_path, wheel_sha256)


def test_provenance_rejects_wrong_installed_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel_path, wheel_sha256, distribution = _write_wheel_and_installation(
        tmp_path, installed_version="9.9.9"
    )
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match="installed.*version"):
        provenance.verify_installed_worker_provenance(wheel_path, wheel_sha256)


def test_provenance_rejects_different_install_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel_path, wheel_sha256, distribution = _write_wheel_and_installation(tmp_path)
    direct_url_path = distribution.root / DIST_INFO_ROOT / "direct_url.json"
    direct_url = json.loads(direct_url_path.read_text(encoding="utf-8"))
    direct_url["url"] = (tmp_path / "stale.whl").resolve().as_uri()
    direct_url_path.write_text(json.dumps(direct_url), encoding="utf-8")
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match="source"):
        provenance.verify_installed_worker_provenance(wheel_path, wheel_sha256)


def test_provenance_rejects_installed_file_mismatch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel_path, wheel_sha256, distribution = _write_wheel_and_installation(tmp_path)
    (distribution.root / "veriflow_hdl_worker" / "runtime.py").write_text(
        "stale runtime", encoding="utf-8"
    )
    _use_distribution(monkeypatch, distribution)

    with pytest.raises(ValueError, match="Installed.*runtime.py"):
        provenance.verify_installed_worker_provenance(wheel_path, wheel_sha256)

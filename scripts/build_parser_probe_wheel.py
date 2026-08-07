import base64
import csv
import email.parser
import gc
import hashlib
import importlib.metadata
import io
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path
from typing import Dict, Tuple


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = ROOT / ".artifacts" / "parser-worker"
PACKAGE_ROOT = ROOT / "python-packages" / "veriflow-hdl-worker"
PACKAGE_BIN = PACKAGE_ROOT / "src" / "veriflow_hdl_worker" / "bin"
WHEEL_NAME = "veriflow_hdl_worker-1.3.2-py3-none-win_amd64.whl"
DIST_INFO_ROOT = "veriflow_hdl_worker-1.3.2.dist-info/"
REPRODUCIBLE_BUILD_EPOCH = "315532800"  # 1980-01-01, the ZIP timestamp floor.
EXPECTED_BUILD_TOOLS = {
    "build": "1.5.0",
    "setuptools": "82.0.1",
    "wheel": "0.46.3",
}
RENAME_ATTEMPTS = 40
RENAME_RETRY_SECONDS = 0.05
RUNTIME_FILES = (
    "parser-worker.exe",
    "web-tree-sitter.wasm",
    "tree-sitter-systemverilog.wasm",
    "manifest.json",
)
BUILD_SOURCE_FILES = (
    "MANIFEST.in",
    "pyproject.toml",
    "setup.py",
    "src/veriflow_hdl_worker/__init__.py",
    "src/veriflow_hdl_worker/runtime.py",
) + tuple(f"src/veriflow_hdl_worker/bin/{name}" for name in RUNTIME_FILES)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_reparse_point(path: Path) -> bool:
    attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(str(path)))


def _relative_package_path(path: Path) -> Path:
    package_root = _absolute(PACKAGE_ROOT)
    candidate = _absolute(path)
    try:
        return candidate.relative_to(package_root)
    except ValueError as error:
        raise ValueError(f"Refusing path outside package root: {candidate}") from error


def _validate_package_path(path: Path) -> None:
    relative = _relative_package_path(path)
    current = _absolute(PACKAGE_ROOT)
    for component in (None,) + relative.parts:
        if component is not None:
            current = current / component
        if not os.path.lexists(current):
            break
        if _is_reparse_point(current):
            raise ValueError(f"Refusing reparse point or junction: {current}")
        if current != _absolute(path) and not stat.S_ISDIR(os.lstat(current).st_mode):
            raise ValueError(f"Package path parent is not a directory: {current}")

    if not os.path.lexists(PACKAGE_ROOT):
        raise ValueError(f"Package root does not exist: {PACKAGE_ROOT}")
    package_root_resolved = PACKAGE_ROOT.resolve(strict=True)
    candidate_resolved = path.resolve(strict=False)
    try:
        candidate_resolved.relative_to(package_root_resolved)
    except ValueError as error:
        raise ValueError(
            f"Refusing package path that resolves outside package root: {path}"
        ) from error


def _remove_detached_path(path: Path) -> None:
    _validate_package_path(path)
    details = os.lstat(path)
    if _is_reparse_point(path):
        raise ValueError(f"Refusing reparse point or junction: {path}")
    if stat.S_ISDIR(details.st_mode):
        with os.scandir(path) as entries:
            children = [path / entry.name for entry in entries]
        for child in children:
            _remove_detached_path(child)
        _validate_package_path(path)
        if _is_reparse_point(path) or not stat.S_ISDIR(os.lstat(path).st_mode):
            raise ValueError(f"Package output changed during removal: {path}")
        path.rmdir()
    elif stat.S_ISREG(details.st_mode):
        _validate_package_path(path)
        if _is_reparse_point(path) or not stat.S_ISREG(os.lstat(path).st_mode):
            raise ValueError(f"Package output changed during removal: {path}")
        path.unlink()
    else:
        raise ValueError(f"Refusing unsupported package output type: {path}")


def _safe_remove_path(path: Path) -> None:
    _validate_package_path(path)
    if not os.path.lexists(path):
        return
    if _is_reparse_point(path):
        raise ValueError(f"Refusing reparse point or junction: {path}")
    _validate_package_path(path)

    quarantine = path.with_name(f".{path.name}.removing-{uuid.uuid4().hex}")
    _validate_package_path(quarantine)
    if os.path.lexists(quarantine):
        raise ValueError(f"Removal quarantine already exists: {quarantine}")
    for attempt in range(RENAME_ATTEMPTS):
        _validate_package_path(path)
        if _is_reparse_point(path):
            raise ValueError(f"Refusing reparse point or junction: {path}")
        try:
            os.replace(path, quarantine)
            break
        except PermissionError:
            if attempt == RENAME_ATTEMPTS - 1:
                raise
            gc.collect()
            time.sleep(RENAME_RETRY_SECONDS)
    try:
        _validate_package_path(quarantine)
        if _is_reparse_point(quarantine):
            raise ValueError(f"Refusing reparse point or junction: {path}")
        _remove_detached_path(quarantine)
    except BaseException:
        if os.path.lexists(quarantine) and not os.path.lexists(path):
            os.replace(quarantine, path)
        raise


def _ensure_package_bin() -> None:
    expected_bin = PACKAGE_ROOT / "src" / "veriflow_hdl_worker" / "bin"
    if _absolute(PACKAGE_BIN) != _absolute(expected_bin):
        raise ValueError(f"Unexpected package bin path: {PACKAGE_BIN}")
    _validate_package_path(PACKAGE_BIN)
    PACKAGE_BIN.mkdir(parents=True, exist_ok=True)
    _validate_package_path(PACKAGE_BIN)
    if not stat.S_ISDIR(os.lstat(PACKAGE_BIN).st_mode):
        raise ValueError(f"Package bin is not a directory: {PACKAGE_BIN}")


def _clean_package_bin() -> None:
    _ensure_package_bin()
    allowed = set(RUNTIME_FILES) | {".gitkeep"}
    entries = list(PACKAGE_BIN.iterdir())
    unexpected = [entry.name for entry in entries if entry.name not in allowed]
    if unexpected:
        raise ValueError(f"Unexpected package bin entries: {sorted(unexpected)}")

    for entry in entries:
        _validate_package_path(entry)
        details = os.lstat(entry)
        if _is_reparse_point(entry) or not stat.S_ISREG(details.st_mode):
            raise ValueError(f"Refusing non-regular package bin entry: {entry}")

    for entry in entries:
        if entry.name in RUNTIME_FILES:
            _safe_remove_path(entry)
    gitkeep = PACKAGE_BIN / ".gitkeep"
    _validate_package_path(PACKAGE_BIN)
    if not os.path.lexists(gitkeep):
        descriptor = os.open(gitkeep, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        os.close(descriptor)
    _validate_package_path(gitkeep)
    if _is_reparse_point(gitkeep) or not stat.S_ISREG(os.lstat(gitkeep).st_mode):
        raise ValueError(f"Package .gitkeep must be a regular file: {gitkeep}")


def _clean_egg_info() -> None:
    source_root = PACKAGE_ROOT / "src"
    _validate_package_path(source_root)
    for egg_info in source_root.glob("*.egg-info"):
        _safe_remove_path(egg_info)


def _clean_build_products() -> None:
    _safe_remove_path(PACKAGE_ROOT / "build")
    _clean_egg_info()


def _clean_outputs() -> None:
    _clean_package_bin()
    _clean_build_products()
    _safe_remove_path(PACKAGE_ROOT / "dist")


def _require_regular_artifact(path: Path) -> None:
    if not os.path.lexists(path):
        raise FileNotFoundError(f"Parser worker build is missing required artifact: {path}")
    if _is_reparse_point(path) or not stat.S_ISREG(os.lstat(path).st_mode):
        raise ValueError(f"Parser worker artifact must be a regular file: {path}")


def _validate_pe_executable(path: Path) -> int:
    file_size = path.stat().st_size
    if file_size < 0x40:
        raise ValueError(f"Truncated DOS header in parser worker executable: {path}")
    with path.open("rb") as stream:
        dos_header = stream.read(0x40)
        if dos_header[0:2] != b"MZ":
            raise ValueError(f"Parser worker executable has no DOS MZ header: {path}")
        pe_offset = struct.unpack_from("<I", dos_header, 0x3C)[0]
        if pe_offset < 0x40 or pe_offset + 26 > file_size:
            raise ValueError(f"Invalid PE header offset in parser worker executable: {path}")

        stream.seek(pe_offset)
        if stream.read(4) != b"PE\0\0":
            raise ValueError(f"Parser worker executable has no PE signature: {path}")
        coff_header = stream.read(20)
        if len(coff_header) != 20:
            raise ValueError(f"Truncated PE COFF header in parser worker executable: {path}")
        machine, section_count = struct.unpack_from("<HH", coff_header)
        optional_size = struct.unpack_from("<H", coff_header, 16)[0]
        if machine != 0x8664:
            raise ValueError(
                f"Parser worker PE machine must be AMD64 0x8664, received 0x{machine:04x}"
            )
        if section_count == 0:
            raise ValueError("Parser worker PE must contain at least one section")
        if optional_size < 2 or pe_offset + 24 + optional_size > file_size:
            raise ValueError("Parser worker PE optional header is truncated or out of bounds")
        section_table_end = pe_offset + 24 + optional_size + section_count * 40
        if section_table_end > file_size:
            raise ValueError("Parser worker PE section table is truncated or out of bounds")
        optional_magic = stream.read(2)
        if len(optional_magic) != 2 or struct.unpack("<H", optional_magic)[0] != 0x20B:
            raise ValueError("Parser worker PE optional header must be PE32+ magic 0x20b")
    return machine


def _copy_runtime() -> None:
    _ensure_package_bin()
    artifacts = [ARTIFACT_ROOT / name for name in RUNTIME_FILES]
    for artifact in artifacts:
        _require_regular_artifact(artifact)
    _validate_pe_executable(ARTIFACT_ROOT / "parser-worker.exe")

    for name, source in zip(RUNTIME_FILES, artifacts):
        destination = PACKAGE_BIN / name
        _validate_package_path(destination)
        if os.path.lexists(destination):
            raise ValueError(f"Package runtime destination already exists: {destination}")
        shutil.copy2(source, destination)


def _validate_runtime() -> int:
    machine = _validate_pe_executable(PACKAGE_BIN / "parser-worker.exe")
    manifest = json.loads((PACKAGE_BIN / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("protocolVersion") != 1:
        raise ValueError("Parser worker manifest protocolVersion must be 1")
    wasm_entries: Dict[str, Tuple[str, Path]] = {
        "webTreeSitter": ("web-tree-sitter.wasm", PACKAGE_BIN / "web-tree-sitter.wasm"),
        "systemVerilog": (
            "tree-sitter-systemverilog.wasm",
            PACKAGE_BIN / "tree-sitter-systemverilog.wasm",
        ),
    }
    for key, (expected_name, wasm_path) in wasm_entries.items():
        metadata = manifest.get("wasm", {}).get(key, {})
        if metadata.get("file") != expected_name:
            raise ValueError(f"Manifest entry {key} does not name {expected_name}")
        if metadata.get("size") != wasm_path.stat().st_size:
            raise ValueError(f"Manifest size does not match {expected_name}")
        if metadata.get("sha256") != _sha256(wasm_path):
            raise ValueError(f"Manifest SHA-256 does not match {expected_name}")
    return machine


def _smoke_packaged_worker() -> None:
    request = {
        "protocolVersion": 1,
        "requestId": "wheel-build-probe",
        "type": "probe",
        "payload": {"source": "module wheel_build; endmodule"},
    }
    process = subprocess.Popen(
        [str(PACKAGE_BIN / "parser-worker.exe")],
        cwd=PACKAGE_BIN,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        stdout, stderr = process.communicate(json.dumps(request) + "\n", timeout=10)
    except subprocess.TimeoutExpired as error:
        process.kill()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.wait(timeout=5)
            raise RuntimeError("Packaged parser worker could not be reaped") from error
        raise RuntimeError(
            f"Packaged parser worker smoke timed out; stdout={stdout!r}; stderr={stderr!r}"
        ) from error
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)

    if process.returncode != 0 or stderr != "":
        raise RuntimeError(
            f"Packaged parser worker smoke failed with code {process.returncode}: {stderr}"
        )
    lines = stdout.splitlines()
    if len(lines) != 1:
        raise RuntimeError(f"Packaged parser worker returned invalid JSONL: {stdout!r}")
    response = json.loads(lines[0])
    expected = {
        "protocolVersion": 1,
        "requestId": "wheel-build-probe",
        "type": "probe",
        "ok": True,
        "payload": {
            "rootType": "source_file",
            "containsModule": True,
            "languageAbi": 15,
        },
    }
    if response != expected:
        raise RuntimeError(f"Packaged parser worker returned invalid probe: {response!r}")


def _validate_build_tools() -> None:
    mismatches = []
    for distribution, expected in EXPECTED_BUILD_TOOLS.items():
        try:
            actual = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            actual = "not installed"
        if actual != expected:
            mismatches.append(f"{distribution}: expected {expected}, found {actual}")
    if mismatches:
        raise RuntimeError("Wheel build tool mismatch: " + "; ".join(mismatches))


def _record_digest(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return "sha256=" + digest.decode("ascii")


def _verify_wheel(wheel_path: Path) -> None:
    with zipfile.ZipFile(wheel_path) as archive:
        ordered_names = archive.namelist()
        if len(ordered_names) != len(set(ordered_names)):
            raise ValueError("Wheel contains duplicate archive members")
        names = set(ordered_names)

        wheel_files = {name for name in names if name.endswith(".dist-info/WHEEL")}
        expected_wheel_file = DIST_INFO_ROOT + "WHEEL"
        if wheel_files != {expected_wheel_file}:
            raise ValueError(
                "Wheel must contain only the expected dist-info root "
                f"{DIST_INFO_ROOT}, found {sorted(wheel_files)}"
            )
        dist_info = DIST_INFO_ROOT
        expected_entries = {
            "veriflow_hdl_worker/__init__.py",
            "veriflow_hdl_worker/runtime.py",
            dist_info + "METADATA",
            dist_info + "WHEEL",
            dist_info + "top_level.txt",
            dist_info + "RECORD",
        }
        expected_entries.update(
            f"veriflow_hdl_worker/bin/{name}" for name in RUNTIME_FILES
        )
        if names != expected_entries:
            raise ValueError(
                "Wheel archive entries differ from the exact expected set: "
                f"{sorted(names ^ expected_entries)}"
            )

        metadata = archive.read(dist_info + "WHEEL").decode("utf-8")
        root_flags = [
            line for line in metadata.splitlines() if line.startswith("Root-Is-Purelib: ")
        ]
        if root_flags != ["Root-Is-Purelib: false"]:
            raise ValueError(f"Unexpected wheel root classification: {root_flags}")
        tags = [line for line in metadata.splitlines() if line.startswith("Tag: ")]
        if tags != ["Tag: py3-none-win_amd64"]:
            raise ValueError(f"Unexpected wheel compatibility tags: {tags}")

        package_metadata = email.parser.Parser().parsestr(
            archive.read(dist_info + "METADATA").decode("utf-8")
        )
        if (
            package_metadata.get("Name") != "veriflow-hdl-worker"
            or package_metadata.get("Version") != "1.3.2"
        ):
            raise ValueError(
                "Wheel METADATA must identify veriflow-hdl-worker version 1.3.2"
            )

        for name in RUNTIME_FILES:
            archive_name = f"veriflow_hdl_worker/bin/{name}"
            archived_hash = hashlib.sha256(archive.read(archive_name)).hexdigest()
            if archived_hash != _sha256(PACKAGE_BIN / name):
                raise ValueError(f"Wheel payload differs from package source: {name}")

        record_name = dist_info + "RECORD"
        record_rows = list(
            csv.reader(io.StringIO(archive.read(record_name).decode("utf-8")))
        )
        if len(record_rows) != len(names):
            raise ValueError("Wheel RECORD row count does not match archive members")
        records = {row[0]: row[1:] for row in record_rows}
        if set(records) != names:
            raise ValueError("Wheel RECORD paths do not match archive members")
        for name in names:
            digest, size = records[name]
            if name == record_name:
                if digest != "" or size != "":
                    raise ValueError("Wheel RECORD self-entry must omit hash and size")
                continue
            data = archive.read(name)
            if digest != _record_digest(data) or size != str(len(data)):
                raise ValueError(f"Wheel RECORD does not verify archive member: {name}")


def _stage_build_source(label: str) -> Path:
    source_root = PACKAGE_ROOT / "build" / f"{label}-source"
    _validate_package_path(source_root)
    if os.path.lexists(source_root):
        raise ValueError(f"Wheel build source staging already exists: {source_root}")
    source_root.mkdir(parents=True)
    _validate_package_path(source_root)

    for relative_name in BUILD_SOURCE_FILES:
        source = PACKAGE_ROOT / relative_name
        _validate_package_path(source)
        _require_regular_artifact(source)
        destination = source_root / relative_name
        _validate_package_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return source_root


def _build_once(label: str) -> Path:
    source_root = _stage_build_source(label)
    output_dir = PACKAGE_ROOT / "dist" / label
    _validate_package_path(output_dir)
    output_dir.mkdir(parents=True)
    environment = os.environ.copy()
    environment["SOURCE_DATE_EPOCH"] = REPRODUCIBLE_BUILD_EPOCH
    environment["PYTHONHASHSEED"] = "0"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "--outdir",
            str(output_dir),
        ],
        cwd=source_root,
        env=environment,
        check=True,
    )
    wheels = list(output_dir.glob("*.whl"))
    expected_wheel = output_dir / WHEEL_NAME
    if wheels != [expected_wheel]:
        raise ValueError(
            f"Expected only {WHEEL_NAME} in {label}, found {[path.name for path in wheels]}"
        )
    _verify_wheel(expected_wheel)
    return expected_wheel


def build_wheel() -> Path:
    _validate_build_tools()
    _clean_outputs()
    _copy_runtime()
    machine = _validate_runtime()
    _smoke_packaged_worker()

    first_wheel = _build_once("repro-first")
    first_hash = _sha256(first_wheel)
    second_wheel = _build_once("repro-second")
    second_hash = _sha256(second_wheel)
    if first_hash != second_hash:
        raise ValueError(
            "Wheel build is not reproducible: "
            f"first SHA-256 {first_hash}, second SHA-256 {second_hash}"
        )

    dist_root = PACKAGE_ROOT / "dist"
    _validate_package_path(dist_root)
    dist_root.mkdir(exist_ok=True)
    final_wheel = dist_root / WHEEL_NAME
    shutil.copyfile(second_wheel, final_wheel)
    wheels = list(dist_root.glob("*.whl"))
    if wheels != [final_wheel]:
        raise ValueError(f"Package dist contains unexpected wheels: {wheels}")
    _verify_wheel(final_wheel)
    print(f"Validated parser worker PE machine: 0x{machine:04x}")
    print(f"Reproducible wheel SHA-256: {second_hash}")
    return final_wheel


def main() -> int:
    print(build_wheel())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

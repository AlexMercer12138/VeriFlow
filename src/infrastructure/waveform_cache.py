from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from src.domain.services.vcd_index_format import DATA_MAGIC, INDEX_VERSION, validate_manifest
from src.domain.services.vcd_index_service import build_vcd_index


DEFAULT_MAX_BYTES = 4 * 1024**3
SAMPLE_BYTES = 64 * 1024
DEFAULT_STALE_LOCK_SECONDS = 30.0


@dataclass(frozen=True)
class SourceFingerprint:
    key: str
    normalized_path: str
    size: int
    mtime_ns: int
    head_sha256: str
    tail_sha256: str
    index_version: int


def waveform_cache_root() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "VeriFlow" / "waveform-cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "VeriFlow" / "waveform-cache"
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "veriflow" / "waveform-cache"


def _normalized_source_path(source: Path) -> str:
    normalized = str(source.resolve()).replace("\\", "/")
    return normalized.lower() if os.name == "nt" else normalized


def _sample_hashes(source: Path, size: int) -> tuple[str, str]:
    with source.open("rb") as handle:
        head = handle.read(SAMPLE_BYTES)
        handle.seek(max(0, size - SAMPLE_BYTES))
        tail = handle.read(SAMPLE_BYTES)
    return hashlib.sha256(head).hexdigest(), hashlib.sha256(tail).hexdigest()


def source_fingerprint(source: Path) -> SourceFingerprint:
    source = Path(source).resolve()
    stat = source.stat()
    normalized_path = _normalized_source_path(source)
    head_sha256, tail_sha256 = _sample_hashes(source, stat.st_size)
    digest = hashlib.sha256()
    digest.update(b"VFI-CACHE-1\0")
    digest.update(normalized_path.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(stat.st_size).encode("ascii"))
    digest.update(b"\0")
    digest.update(str(stat.st_mtime_ns).encode("ascii"))
    digest.update(b"\0")
    digest.update(bytes.fromhex(head_sha256))
    digest.update(bytes.fromhex(tail_sha256))
    digest.update(str(INDEX_VERSION).encode("ascii"))
    return SourceFingerprint(
        key=digest.hexdigest(),
        normalized_path=normalized_path,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        head_sha256=head_sha256,
        tail_sha256=tail_sha256,
        index_version=INDEX_VERSION,
    )


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class _CacheLock:
    def __init__(self, path: Path, stale_seconds: float) -> None:
        self.path = path
        self.stale_seconds = stale_seconds
        self.token = uuid.uuid4().hex
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._acquired = False

    def _payload(self) -> dict:
        now_ms = time.time_ns() // 1_000_000
        return {
            "pid": os.getpid(),
            "createdAtMs": now_ms,
            "heartbeatMs": now_ms,
            "token": self.token,
        }

    def _write_initial(self) -> None:
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            data = json.dumps(self._payload(), separators=(",", ":")).encode("utf-8")
            os.write(descriptor, data)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _write_heartbeat(self) -> None:
        temporary = self.path.with_name(f"{self.path.name}.heartbeat.{self.token}")
        try:
            temporary.write_text(
                json.dumps(self._payload(), separators=(",", ":")),
                encoding="utf-8",
            )
            current = json.loads(self.path.read_text(encoding="utf-8"))
            if current.get("token") == self.token:
                os.replace(temporary, self.path)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            temporary.unlink(missing_ok=True)

    def _heartbeat_loop(self) -> None:
        interval = max(0.1, self.stale_seconds / 3)
        while not self._stop.wait(interval):
            self._write_heartbeat()

    def _reclaim_if_stale(self) -> bool:
        try:
            original = self.path.read_bytes()
            payload = json.loads(original.decode("utf-8"))
            heartbeat_ms = int(payload.get("heartbeatMs", 0))
            pid = int(payload.get("pid", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        stale = not _pid_alive(pid) or (
            time.time_ns() // 1_000_000 - heartbeat_ms > self.stale_seconds * 1000
        )
        if not stale:
            return False
        try:
            if self.path.read_bytes() != original:
                return False
            self.path.unlink()
            return True
        except OSError:
            return False

    def acquire(self) -> bool:
        for _attempt in range(2):
            try:
                self._write_initial()
                self._acquired = True
                self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
                self._thread.start()
                return True
            except FileExistsError:
                if not self._reclaim_if_stale():
                    return False
        return False

    def release(self) -> None:
        if not self._acquired:
            return
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("token") == self.token:
                self.path.unlink(missing_ok=True)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        self._acquired = False


class WaveformCache:
    def __init__(
        self,
        *,
        root: Optional[Path] = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
        builder: Callable = build_vcd_index,
        stale_lock_seconds: float = DEFAULT_STALE_LOCK_SECONDS,
        wait_seconds: float = 0.1,
    ) -> None:
        if max_bytes <= 0:
            raise ValueError("waveform cache size must be positive")
        self.root = Path(root) if root is not None else waveform_cache_root()
        self.max_bytes = max_bytes
        self.builder = builder
        self.stale_lock_seconds = stale_lock_seconds
        self.wait_seconds = wait_seconds
        self._active: set[str] = set()
        self.root.mkdir(parents=True, exist_ok=True)
        self.cleanup()

    @staticmethod
    def _atomic_manifest_write(path: Path, manifest: dict) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _entry_size(entry: Path) -> int:
        return sum(item.stat().st_size for item in entry.rglob("*") if item.is_file())

    def _valid_entry(self, entry: Path, fingerprint: Optional[SourceFingerprint] = None) -> bool:
        try:
            manifest = validate_manifest(
                json.loads((entry / "manifest.json").read_text(encoding="utf-8"))
            )
            if fingerprint is not None and manifest.get("sourceFingerprint") not in {
                None,
                fingerprint.key,
            }:
                return False
            data_path = entry / manifest["dataFile"]
            with data_path.open("rb") as handle:
                return handle.read(len(DATA_MAGIC)) == DATA_MAGIC
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            return False

    def _touch_entry(self, entry: Path, fingerprint: SourceFingerprint) -> None:
        manifest_path = entry / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sourceFingerprint"] = fingerprint.key
        manifest["lastAccessNs"] = str(time.time_ns())
        self._atomic_manifest_write(manifest_path, manifest)

    def _open_fingerprint(self, fingerprint: SourceFingerprint) -> Optional[Path]:
        entry = self.root / fingerprint.key
        if not self._valid_entry(entry, fingerprint):
            return None
        self._touch_entry(entry, fingerprint)
        self._active.add(fingerprint.key)
        return entry

    def open_existing(self, source: Path) -> Optional[Path]:
        return self._open_fingerprint(source_fingerprint(source))

    def get_or_build(
        self,
        source: Path,
        *,
        on_metadata: Optional[Callable[[dict], None]] = None,
        on_progress: Optional[Callable[[dict], None]] = None,
        cancelled: Optional[Callable[[], bool]] = None,
    ) -> Path:
        source = Path(source).resolve()
        fingerprint = source_fingerprint(source)
        while True:
            existing = self._open_fingerprint(fingerprint)
            if existing is not None:
                return existing
            if cancelled is not None and cancelled():
                from src.domain.services.vcd_index_service import VcdIndexCancelled

                raise VcdIndexCancelled()
            lock = _CacheLock(
                self.root / f"{fingerprint.key}.lock",
                self.stale_lock_seconds,
            )
            if lock.acquire():
                break
            if on_progress is not None:
                on_progress({"phase": "waiting", "completed": 0, "total": 0, "percent": 0})
            time.sleep(self.wait_seconds)

        temporary = self.root / (
            f"{fingerprint.key}.tmp.{os.getpid()}.{uuid.uuid4().hex}"
        )
        final = self.root / fingerprint.key
        try:
            existing = self._open_fingerprint(fingerprint)
            if existing is not None:
                return existing
            self.builder(
                source,
                temporary,
                on_metadata=on_metadata,
                on_progress=on_progress,
                cancelled=cancelled,
            )
            self._touch_entry(temporary, fingerprint)
            if not self._valid_entry(temporary, fingerprint):
                raise ValueError("waveform cache build did not produce a valid index")
            if final.exists():
                shutil.rmtree(temporary, ignore_errors=True)
            else:
                os.replace(temporary, final)
            self._active.add(fingerprint.key)
            self.cleanup(protected={fingerprint.key})
            return final
        finally:
            shutil.rmtree(temporary, ignore_errors=True)
            lock.release()

    def release(self, index_dir: Path) -> None:
        self._active.discard(Path(index_dir).name)

    def cleanup(self, protected: Optional[set[str]] = None) -> None:
        protected_keys = self._active | set(protected or ())
        entries: list[tuple[int, int, Path]] = []
        total = 0
        for entry in self.root.iterdir():
            if not entry.is_dir() or ".tmp." in entry.name:
                continue
            if not self._valid_entry(entry):
                if entry.name not in protected_keys:
                    shutil.rmtree(entry, ignore_errors=True)
                continue
            try:
                manifest = json.loads((entry / "manifest.json").read_text(encoding="utf-8"))
                access_ns = int(manifest.get("lastAccessNs", entry.stat().st_mtime_ns))
                size = self._entry_size(entry)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            total += size
            entries.append((access_ns, size, entry))

        for _access_ns, size, entry in sorted(entries, key=lambda item: item[0]):
            if total <= self.max_bytes:
                break
            if entry.name in protected_keys:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            if not entry.exists():
                total -= size

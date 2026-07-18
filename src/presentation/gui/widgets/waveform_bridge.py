# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from PySide6.QtCore import QObject, QThread, Qt, Signal, Slot

from src.domain.services.vcd_index_service import (
    VcdIndexCancelled,
    VcdIndexReader,
)
from src.infrastructure.waveform_cache import WaveformCache


_LIVE_THREADS: set[QThread] = set()


class WaveformIndexWorker(QObject):
    message = Signal(str)
    finished = Signal()

    def __init__(
        self,
        *,
        cache: Optional[WaveformCache] = None,
        reader_factory: Callable[[Path], VcdIndexReader] = VcdIndexReader,
    ) -> None:
        super().__init__()
        self._cache = cache
        self._reader_factory = reader_factory
        self._reader: Optional[VcdIndexReader] = None
        self._reader_generation = 0
        self._index_dir: Optional[Path] = None
        self._generation = 0
        self._cancelled_loads: set[int] = set()
        self._cancelled_requests: set[tuple[int, str]] = set()
        self._state_lock = threading.RLock()
        self._last_progress_at = 0.0
        self._last_progress_phase = ""
        self._disposed = False

    def _cache_instance(self) -> WaveformCache:
        if self._cache is None:
            self._cache = WaveformCache()
        return self._cache

    def _send(self, message_type: str, generation: int, **payload) -> None:
        event = {"type": message_type, "generation": generation, **payload}
        self.message.emit(json.dumps(event, ensure_ascii=False, separators=(",", ":")))

    def request_cancel_load(self, generation: int) -> None:
        with self._state_lock:
            self._cancelled_loads.add(generation)

    def request_cancel_request(self, generation: int, request_id: object) -> None:
        with self._state_lock:
            self._cancelled_requests.add((generation, str(request_id)))

    def _load_cancelled(self, generation: int) -> bool:
        with self._state_lock:
            return (
                self._disposed
                or generation in self._cancelled_loads
                or generation != self._generation
            )

    def _request_cancelled(self, generation: int, request_id: object) -> bool:
        with self._state_lock:
            return (
                self._disposed
                or generation != self._generation
                or (generation, str(request_id)) in self._cancelled_requests
            )

    def _progress(self, generation: int, event: dict) -> None:
        if self._load_cancelled(generation):
            return
        now = time.monotonic()
        phase = str(event.get("phase", ""))
        always_emit = phase != self._last_progress_phase or event.get("percent") == 100
        if not always_emit and now - self._last_progress_at < 0.05:
            return
        self._last_progress_at = now
        self._last_progress_phase = phase
        self._send("indexProgress", generation, progress=event)

    def _open_file(self, message: dict) -> None:
        generation = int(message["generation"])
        source = Path(message["source"]).resolve()
        with self._state_lock:
            self._generation = generation
            self._cancelled_loads.discard(generation)
            self._cancelled_requests = {
                item for item in self._cancelled_requests if item[0] == generation
            }
        self._last_progress_at = 0.0
        self._last_progress_phase = ""
        metadata_sent = False

        def on_metadata(metadata: dict) -> None:
            nonlocal metadata_sent
            if self._load_cancelled(generation):
                return
            metadata_sent = True
            self._send(
                "waveformMetadata",
                generation,
                fileName=str(source),
                data=metadata,
            )

        try:
            cache = self._cache_instance()
            index_dir = Path(
                cache.get_or_build(
                    source,
                    on_metadata=on_metadata,
                    on_progress=lambda event: self._progress(generation, event),
                    cancelled=lambda: self._load_cancelled(generation),
                )
            )
            if self._load_cancelled(generation):
                cache.release(index_dir)
                raise VcdIndexCancelled()
            reader = self._reader_factory(index_dir)
            if not metadata_sent:
                metadata = getattr(reader, "metadata", None)
                if metadata is not None:
                    on_metadata(metadata)
            previous_dir = self._index_dir
            self._reader = reader
            self._reader_generation = generation
            self._index_dir = index_dir
            if previous_dir is not None and previous_dir != index_dir:
                cache.release(previous_dir)
            self._send("indexReady", generation, fileName=str(source))
        except VcdIndexCancelled:
            self._send("indexCancelled", generation)
        except Exception as error:
            self._send("reloadFailed", generation, message=str(error))

    def _window_request(self, message: dict) -> None:
        generation = int(message["generation"])
        request_id = message["requestId"]
        if self._request_cancelled(generation, request_id):
            return
        if self._reader is None or self._reader_generation != generation:
            raise RuntimeError("waveform index is not ready")
        references = list(message.get("references") or ())
        if len(references) > 256:
            raise ValueError("window request contains too many signals")
        pixel_width = max(1, min(8192, int(message.get("pixelWidth", 1))))
        if references:
            pixel_width = min(pixel_width, max(1, 32768 // (2 * len(references))))
        series = []
        for reference in references:
            if self._request_cancelled(generation, request_id):
                return
            payload = self._reader.query_window_for_reference(
                str(reference),
                int(message.get("start", 0)),
                int(message.get("end", 0)),
                pixel_width=pixel_width,
                cancelled=lambda: self._request_cancelled(generation, request_id),
            )
            series.append({"reference": reference, **payload})
        if not self._request_cancelled(generation, request_id):
            self._send("windowData", generation, requestId=request_id, series=series)

    def _value_request(self, message: dict) -> None:
        generation = int(message["generation"])
        request_id = message["requestId"]
        if self._request_cancelled(generation, request_id):
            return
        if self._reader is None or self._reader_generation != generation:
            raise RuntimeError("waveform index is not ready")
        references = [str(item) for item in message.get("references") or ()]
        values = self._reader.values_at(references, int(message.get("time", 0)))
        if not self._request_cancelled(generation, request_id):
            self._send("cursorValues", generation, requestId=request_id, values=values)

    def _search_request(self, message: dict) -> None:
        generation = int(message["generation"])
        request_id = message["requestId"]
        if self._request_cancelled(generation, request_id):
            return
        if self._reader is None or self._reader_generation != generation:
            raise RuntimeError("waveform index is not ready")
        result = self._reader.search(
            str(message["reference"]),
            int(message.get("cursorTime", 0)),
            int(message.get("direction", 1)),
            str(message.get("mode", "change")),
            str(message.get("query", "")),
            bit_index=message.get("bitIndex"),
            cancelled=lambda: self._request_cancelled(generation, request_id),
        )
        if not self._request_cancelled(generation, request_id):
            self._send("searchResult", generation, requestId=request_id, result=result)

    def _dispose(self) -> None:
        with self._state_lock:
            self._disposed = True
            self._cancelled_loads.add(self._generation)
        if self._index_dir is not None and self._cache is not None:
            self._cache.release(self._index_dir)
            self._index_dir = None
        self._reader = None
        self._reader_generation = 0
        self.finished.emit()

    @Slot(str)
    def handle_message(self, payload: str) -> None:
        try:
            message = json.loads(payload)
            message_type = message.get("type")
            if message_type == "openFile":
                self._open_file(message)
            elif message_type == "windowRequest":
                self._window_request(message)
            elif message_type == "valueRequest":
                self._value_request(message)
            elif message_type == "searchRequest":
                self._search_request(message)
            elif message_type == "dispose":
                self._dispose()
        except VcdIndexCancelled:
            return
        except Exception as error:
            try:
                message = json.loads(payload)
                generation = int(message.get("generation", self._generation))
                request_id = message.get("requestId")
            except Exception:
                generation = self._generation
                request_id = None
            self._send(
                "requestError",
                generation,
                requestId=request_id,
                message=str(error),
            )


class WaveformBridge(QObject):
    message = Signal(str)
    _dispatch = Signal(str)

    _ALLOWED_TYPES = {
        "ready",
        "openFile",
        "windowRequest",
        "valueRequest",
        "searchRequest",
        "cancelRequest",
        "cancelLoad",
        "retryLoad",
        "dispose",
    }

    def __init__(
        self,
        parent: Optional[QObject] = None,
        *,
        worker: Optional[WaveformIndexWorker] = None,
        start_thread: bool = True,
    ) -> None:
        super().__init__(parent)
        self._worker = worker or WaveformIndexWorker()
        self._generation = 0
        self._closed = False
        self._thread: Optional[QThread] = None
        self._worker.message.connect(self.message.emit)
        if start_thread:
            self._thread = QThread()
            _LIVE_THREADS.add(self._thread)
            self._worker.moveToThread(self._thread)
            self._dispatch.connect(self._worker.handle_message, Qt.QueuedConnection)
            self._worker.finished.connect(self._thread.quit)
            self._thread.finished.connect(self._worker.deleteLater)
            self._thread.finished.connect(
                lambda thread=self._thread: _LIVE_THREADS.discard(thread)
            )
            self._thread.start()
        else:
            self._dispatch.connect(self._worker.handle_message)

    @property
    def generation(self) -> int:
        return self._generation

    def _bridge_error(self, message: str) -> None:
        self.message.emit(
            json.dumps(
                {"type": "bridgeError", "generation": self._generation, "message": message},
                separators=(",", ":"),
            )
        )

    @Slot(str)
    def send(self, payload: str) -> None:
        if self._closed:
            return
        if not isinstance(payload, str) or len(payload) > 1024 * 1024:
            self._bridge_error("invalid waveform bridge payload")
            return
        try:
            message = json.loads(payload)
            if not isinstance(message, dict):
                raise ValueError("waveform bridge message must be an object")
            message_type = message.get("type")
            if message_type not in self._ALLOWED_TYPES:
                raise ValueError("unsupported waveform bridge message")
        except (ValueError, json.JSONDecodeError) as error:
            self._bridge_error(str(error))
            return

        generation = int(message.get("generation", self._generation))
        if message_type == "cancelRequest":
            self._worker.request_cancel_request(generation, message.get("requestId"))
            return
        if message_type == "cancelLoad":
            self._worker.request_cancel_load(generation)
            return
        if message_type in {"ready", "retryLoad"}:
            return
        self._dispatch.emit(json.dumps(message, ensure_ascii=False, separators=(",", ":")))

    def open_file(self, source: Path) -> int:
        if self._generation:
            self._worker.request_cancel_load(self._generation)
        self._generation += 1
        self.send(
            json.dumps(
                {
                    "type": "openFile",
                    "generation": self._generation,
                    "source": str(Path(source).resolve()),
                },
                ensure_ascii=False,
            )
        )
        return self._generation

    def post_message(self, message: dict) -> None:
        self.message.emit(json.dumps(message, ensure_ascii=False, separators=(",", ":")))

    @Slot()
    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._worker.request_cancel_load(self._generation)
        self._dispatch.emit(
            json.dumps({"type": "dispose", "generation": self._generation})
        )

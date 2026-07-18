# -*- coding: utf-8 -*-
"""
Desktop smoke test for the built-in waveform viewer.

Usage:
    python tests/waveform_viewer_smoke.py [path/to/file.vcd]
"""

import os
import sys
import json
from pathlib import Path


if __name__ != "__main__":
    import pytest

    pytest.skip(
        "desktop QtWebEngine smoke test; run directly with python tests/waveform_viewer_smoke.py",
        allow_module_level=True,
    )


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _default_vcd() -> Path:
    candidates = [
        ROOT / "tests" / "fixtures" / "waveform_debug.vcd",
        Path("D:/Software/VeriWave/test-vcd-file-2.vcd"),
        ROOT / "tests" / "project_test" / "uart_tb.vcd",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("No default VCD file found. Pass a .vcd file path.")


def _configure_qt_webengine() -> None:
    os.environ.setdefault("QT_OPENGL", "software")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    required = [
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-logging",
        "--enable-webgl-software-rendering",
        "--ignore-gpu-blocklist",
        "--log-level=3",
    ]
    missing = [flag for flag in required if flag not in flags]
    if missing:
        os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(
            part for part in [flags, " ".join(missing)] if part
        )


def _inspect_waveform_image(image, widget_size, source: str) -> dict:
    if image.isNull():
        return {
            "source": source,
            "width": 0,
            "height": 0,
            "different": 0,
            "colored": 0,
            "greenish": 0,
            "sampled": 0,
            "ok": False,
        }

    # Match the shared viewer layout: 42px toolbar, 300px library list,
    # 150px waveform-name column, 24px status bar.
    dpr_x = image.width() / max(1, widget_size.width())
    dpr_y = image.height() / max(1, widget_size.height())
    x0 = min(image.width() - 1, max(0, int(450 * dpr_x)))
    y0 = min(image.height() - 1, max(0, int(42 * dpr_y)))
    x1 = image.width()
    y1 = max(y0 + 1, min(image.height(), int(image.height() - 24 * dpr_y)))

    bg = (17, 19, 24)
    stride = max(2, int(round(max(dpr_x, dpr_y) * 3)))
    different = 0
    colored = 0
    greenish = 0
    sampled = 0

    for y in range(y0, y1, stride):
        for x in range(x0, x1, stride):
            color = image.pixelColor(x, y)
            r = color.red()
            g = color.green()
            b = color.blue()
            sampled += 1

            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 28:
                different += 1

            max_c = max(r, g, b)
            min_c = min(r, g, b)
            if max_c > 105 and max_c - min_c > 42:
                colored += 1

            if g > r + 30 and g > b + 10 and g > 100:
                greenish += 1

    colored_ratio = colored / max(1, sampled)
    different_ratio = different / max(1, sampled)
    return {
        "source": source,
        "width": image.width(),
        "height": image.height(),
        "different": different,
        "colored": colored,
        "greenish": greenish,
        "sampled": sampled,
        "ok": different > 700 and colored > 80 and different_ratio > 0.006 and colored_ratio > 0.0008,
    }


def _grab_waveform_stats(view) -> dict:
    stats = []

    widget_image = view.grab().toImage()
    stats.append(_inspect_waveform_image(widget_image, view.size(), "widget"))

    window = view.windowHandle()
    screen = window.screen() if window is not None else None
    if screen is not None:
        screen_image = screen.grabWindow(int(view.winId())).toImage()
        stats.append(_inspect_waveform_image(screen_image, view.size(), "screen"))

    return max(stats, key=lambda item: (item["ok"], item["colored"], item["different"]))


def _legacy_main() -> int:
    _configure_qt_webengine()

    from PySide6.QtCore import QTimer, QUrl
    from PySide6.QtWidgets import QApplication
    from PySide6.QtWebEngineWidgets import QWebEngineView

    from src.domain.services.vcd_parser_service import VcdParserService
    from src.presentation.gui.widgets.waveform_html import _build_waveform_html

    wave_file = Path(sys.argv[1]) if len(sys.argv) > 1 else _default_vcd()
    if not wave_file.exists():
        print(f"[ERROR] VCD file not found: {wave_file}")
        return 2

    data = VcdParserService().parse(wave_file.read_text(encoding="utf-8", errors="ignore"))
    html = _build_waveform_html(str(wave_file), data)

    app = QApplication.instance() or QApplication([])
    app.setQuitOnLastWindowClosed(False)
    view = QWebEngineView()
    view.resize(1280, 720)
    view.setWindowTitle("VeriFlow Waveform Viewer Smoke Test")
    view.show()

    result = {"ok": False, "message": "timeout"}
    attempts = {"count": 0, "last": None}
    primed = {"done": False}
    grouped = {"done": False, "scope": ""}
    bus_expanded = {"done": False, "bits": 0}
    formatted = {"done": False}
    name_mode = {"done": False}
    layout_roundtrip = {"done": False}
    bus_bit_click = {"done": False}
    cursor_measure = {"done": False}
    conditional_search = {"done": False}
    layout_reload = {
        "requested": False,
        "verified": False,
        "waveforms": 0,
        "groups": 0,
        "bus_bits": 0,
        "cursor_a": 0,
        "cursor_b": None,
        "active_cursor": "a",
    }
    multi_select = {"done": False}
    initial_state = {"checked": False}

    def finish(ok: bool, message: str) -> None:
        if result.get("done"):
            return
        result["done"] = True
        result["ok"] = ok
        result["message"] = message
        view.close()
        QTimer.singleShot(0, app.quit)

    def inspect() -> None:
        if not initial_state["checked"]:
            QApplication.processEvents()
            stats = _grab_waveform_stats(view)
            initial_state["checked"] = True
            if stats["greenish"] > 80:
                finish(False, "initial waveform should be empty: " + repr(stats))
                return
            QTimer.singleShot(0, inspect)
            return

        if not grouped["done"]:
            grouped["done"] = True

            def on_state(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "wave viewer state failed: " + repr(state))
                    return
                scopes = (state or {}).get("scopes") or []
                scope = scopes[0] if scopes else ""
                grouped["scope"] = scope

                def on_grouped(next_state) -> None:
                    try:
                        next_state = json.loads(next_state or "{}")
                    except json.JSONDecodeError:
                        finish(False, "scope grouped add returned invalid state: " + repr(next_state))
                        return
                    waveforms = (next_state or {}).get("waveforms", 0)
                    groups = (next_state or {}).get("groups", 0)
                    if groups != 1 or waveforms <= 0:
                        finish(False, "scope grouped add failed: " + repr(next_state))
                        return
                    QTimer.singleShot(0, inspect)

                script = (
                    "JSON.stringify(window.__veriflowWaveViewer ? "
                    f"window.__veriflowWaveViewer.addScope({json.dumps(scope)}, true, true) : {{}});"
                )
                view.page().runJavaScript(script, on_grouped)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? window.__veriflowWaveViewer.state() : {});",
                on_state,
            )
            return

        if not bus_expanded["done"]:
            bus_expanded["done"] = True

            def on_bus_expanded(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "bus expand returned invalid state: " + repr(state))
                    return
                bits = int((state or {}).get("busBits", 0))
                rows = int((state or {}).get("displayRows", 0))
                waveforms = int((state or {}).get("waveforms", 0))
                bus_expanded["bits"] = bits
                if bits <= 0 or rows <= waveforms:
                    finish(False, "bus expand failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? window.__veriflowWaveViewer.expandFirstBus() : {});",
                on_bus_expanded,
            )
            return

        if not name_mode["done"]:
            name_mode["done"] = True

            def on_name_mode(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "name mode returned invalid state: " + repr(state))
                    return
                first_name = str((state or {}).get("firstName", ""))
                if (
                    state.get("mode") != "full"
                    or not state.get("hasMainResize")
                    or not state.get("hasWaveNameResize")
                    or "." not in first_name
                ):
                    finish(False, "name mode or resize handle check failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? window.__veriflowWaveViewer.setFirstSignalNameMode('full') : {});",
                on_name_mode,
            )
            return

        if not formatted["done"]:
            formatted["done"] = True

            def on_formatted(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "formatter samples returned invalid state: " + repr(state))
                    return
                expected = {
                    "default4": "1010",
                    "default8": "AA",
                    "signed8": "170",
                    "octal8": "252",
                    "unknown4": "X",
                    "mixed4": "XZ",
                    "binary8": "0010 1011",
                    "hex8": "2B",
                    "hex32": "0000 0162",
                    "bit0": "0",
                    "bit1": "1",
                    "bit3": "1",
                    "bit8": "0",
                }
                mismatches = {
                    key: (state.get(key), value)
                    for key, value in expected.items()
                    if state.get(key) != value
                }
                if mismatches:
                    finish(False, "formatter samples failed: " + repr(mismatches))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? window.__veriflowWaveViewer.formatSamples() : {});",
                on_formatted,
            )
            return

        if not layout_roundtrip["done"]:
            layout_roundtrip["done"] = True

            def on_layout_roundtrip(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "layout round-trip returned invalid state: " + repr(state))
                    return
                if (
                    state.get("version") != 1
                    or state.get("beforeWaveforms", 0) <= 0
                    or state.get("beforeWaveforms") != state.get("afterWaveforms")
                    or state.get("beforeGroups") != state.get("afterGroups")
                    or state.get("beforeBusBits") != state.get("afterBusBits")
                    or not state.get("restored")
                ):
                    finish(False, "layout round-trip failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer && "
                "window.__veriflowWaveViewer.layoutRoundTripSamples ? "
                "window.__veriflowWaveViewer.layoutRoundTripSamples() : {missing: true});",
                on_layout_roundtrip,
            )
            return

        if not multi_select["done"]:
            multi_select["done"] = True

            def on_multi_select(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "multi-select samples returned invalid state: " + repr(state))
                    return
                if (
                    state.get("initialCount") != 6
                    or state.get("selectedCount") != 3
                    or not state.get("colored")
                    or not state.get("movedDownChanged")
                    or not state.get("movedUpRestored")
                    or state.get("movedDownSelected") != [2, 3, 4]
                    or state.get("movedUpSelected") != [1, 2, 3]
                    or state.get("remainingCount") != 3
                    or state.get("selectedStillVisible")
                ):
                    finish(False, "multi-select batch operations failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? window.__veriflowWaveViewer.multiSelectSamples() : {});",
                on_multi_select,
            )
            return

        if not bus_bit_click["done"]:
            bus_bit_click["done"] = True

            def on_bus_bit_click(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "bus-bit click returned invalid state: " + repr(state))
                    return
                if not state.get("selected"):
                    finish(False, "bus-bit click selection failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer && "
                "window.__veriflowWaveViewer.busBitClickSelectionSample ? "
                "window.__veriflowWaveViewer.busBitClickSelectionSample() : {missing: true});",
                on_bus_bit_click,
            )
            return

        if not cursor_measure["done"]:
            cursor_measure["done"] = True

            def on_cursor_measure(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "cursor measurement returned invalid state: " + repr(state))
                    return
                if (
                    state.get("cursorA") != 12
                    or state.get("cursorB") != 17
                    or state.get("activeCursor") != "b"
                    or state.get("deltaText") != "50 ns"
                    or state.get("frequencyText") != "20 MHz"
                ):
                    finish(False, "cursor measurement failed: " + repr(state))
                    return
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer && "
                "window.__veriflowWaveViewer.setCursorSamples ? "
                "window.__veriflowWaveViewer.setCursorSamples(12, 17, 'b') : {missing: true});",
                on_cursor_measure,
            )
            return

        if not primed["done"]:
            if not conditional_search["done"]:
                conditional_search["done"] = True

                def on_conditional_search(state) -> None:
                    try:
                        state = json.loads(state or "{}")
                    except json.JSONDecodeError:
                        finish(False, "conditional search returned invalid state: " + repr(state))
                        return
                    expected = {
                        "rising": 5,
                        "falling": 10,
                        "exact": 6,
                        "xz": 12,
                        "bitRising": 6,
                        "invalidStayed": True,
                        "boundaryStayed": True,
                    }
                    mismatches = {
                        key: (state.get(key), value)
                        for key, value in expected.items()
                        if state.get(key) != value
                    }
                    if mismatches:
                        finish(False, "conditional search failed: " + repr(mismatches))
                        return
                    QTimer.singleShot(0, inspect)

                view.page().runJavaScript(
                    "JSON.stringify(window.__veriflowWaveViewer && "
                    "window.__veriflowWaveViewer.conditionalSearchSamples ? "
                    "window.__veriflowWaveViewer.conditionalSearchSamples() : {missing: true});",
                    on_conditional_search,
                )
                return

            primed["done"] = True
            view.page().runJavaScript(
                "window.__veriflowWaveViewer && window.__veriflowWaveViewer.addFirstSignals(8);"
            )
            QTimer.singleShot(900, inspect)
            return

        if not layout_reload["requested"]:
            def on_layout_flushed(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "layout flush returned invalid state: " + repr(state))
                    return
                if not state.get("saved") or state.get("waveforms", 0) <= 0:
                    finish(False, "layout flush failed: " + repr(state))
                    return
                layout_reload["requested"] = True
                layout_reload["waveforms"] = state.get("waveforms", 0)
                layout_reload["groups"] = state.get("groups", 0)
                layout_reload["bus_bits"] = state.get("busBits", 0)
                layout_reload["cursor_a"] = state.get("cursorA")
                layout_reload["cursor_b"] = state.get("cursorB")
                layout_reload["active_cursor"] = state.get("activeCursor")
                view.setHtml(html, QUrl.fromLocalFile(str(wave_file.parent)))

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer && "
                "window.__veriflowWaveViewer.flushLayoutSave ? "
                "window.__veriflowWaveViewer.flushLayoutSave() : {missing: true});",
                on_layout_flushed,
            )
            return

        if not layout_reload["verified"]:
            def on_layout_reloaded(state) -> None:
                try:
                    state = json.loads(state or "{}")
                except json.JSONDecodeError:
                    finish(False, "reloaded layout returned invalid state: " + repr(state))
                    return
                if (
                    state.get("waveforms") != layout_reload["waveforms"]
                    or state.get("groups") != layout_reload["groups"]
                    or state.get("busBits") != layout_reload["bus_bits"]
                    or state.get("cursorA") != layout_reload["cursor_a"]
                    or state.get("cursorB") != layout_reload["cursor_b"]
                    or state.get("activeCursor") != layout_reload["active_cursor"]
                ):
                    finish(False, "persisted layout reload failed: " + repr(state))
                    return
                layout_reload["verified"] = True
                QTimer.singleShot(0, inspect)

            view.page().runJavaScript(
                "JSON.stringify(window.__veriflowWaveViewer ? "
                "window.__veriflowWaveViewer.state() : {});",
                on_layout_reloaded,
            )
            return

        QApplication.processEvents()
        stats = _grab_waveform_stats(view)
        attempts["count"] += 1
        attempts["last"] = stats
        if stats["ok"]:
            finish(True, repr(stats))
            return
        if attempts["count"] < 8:
            QTimer.singleShot(700, inspect)
            return
        finish(False, repr(stats))

    def loaded(ok: bool) -> None:
        if not ok:
            finish(False, "load failed")
        else:
            QTimer.singleShot(1800, inspect)

    view.loadFinished.connect(loaded)
    view.setHtml(html, QUrl.fromLocalFile(str(wave_file.parent)))
    QTimer.singleShot(12000, lambda: finish(False, "timeout"))
    app.exec()

    if result["ok"]:
        scope_text = grouped["scope"] or "All scopes"
        print(
            "[OK] Built-in waveform viewer rendered; "
            "persisted layout reload checked; dual cursors checked; conditional search checked; "
            f"grouped scope checked: {scope_text}; "
            f"bus bits checked: {bus_expanded['bits']}; "
            f"{result['message']}"
        )
        return 0
    print(f"[ERROR] Built-in waveform viewer smoke test failed: {result['message']}")
    return 1


def _indexed_main() -> int:
    import shutil
    import tempfile

    _configure_qt_webengine()

    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from src.infrastructure.waveform_cache import WaveformCache
    from src.presentation.gui.widgets.waveform_bridge import (
        WaveformBridge,
        WaveformIndexWorker,
    )
    from src.presentation.gui.widgets.waveform_viewer_panel import WaveformViewerPanel

    requested = [argument for argument in sys.argv[1:] if argument != "--legacy"]
    wave_file = Path(requested[0]) if requested else _default_vcd()
    if not wave_file.exists():
        print(f"[ERROR] VCD file not found: {wave_file}")
        return 2

    temporary = tempfile.TemporaryDirectory(prefix="veriflow-indexed-smoke-")
    root = Path(temporary.name)
    source = root / wave_file.name
    shutil.copyfile(wave_file, source)
    with source.open("a", encoding="utf-8") as handle:
        for timestamp in range(21, 5001):
            handle.write(f"#{timestamp}\n{timestamp % 2}!\n")
    cache = WaveformCache(root=root / "cache")
    bridge = WaveformBridge(
        worker=WaveformIndexWorker(cache=cache),
        start_thread=True,
    )

    app = QApplication.instance() or QApplication([])
    panel = WaveformViewerPanel(bridge=bridge)
    app.setQuitOnLastWindowClosed(False)
    panel.resize(1280, 720)
    panel.setWindowTitle("VeriFlow Indexed Waveform Smoke Test")
    panel.show()
    view = panel._view
    if view is None:
        temporary.cleanup()
        print("[ERROR] QtWebEngine is unavailable")
        return 2

    messages = []
    bridge.message.connect(lambda payload: messages.append(json.loads(payload)))
    state = {
        "primed": False,
        "search_requested": False,
        "javascript_pending": False,
        "done": False,
    }
    result = {"ok": False, "message": "timeout"}

    def finish(ok: bool, message: str) -> None:
        if state["done"]:
            return
        state["done"] = True
        result["ok"] = ok
        result["message"] = message
        panel.close()

        def quit_after_worker() -> None:
            thread = bridge._thread
            if thread is not None and thread.isRunning():
                QTimer.singleShot(20, quit_after_worker)
                return
            panel.deleteLater()
            QTimer.singleShot(0, app.quit)

        QTimer.singleShot(0, quit_after_worker)

    def inspect() -> None:
        if state["done"]:
            return
        types = [message.get("type") for message in messages]
        failures = [
            message for message in messages
            if message.get("type") in {"reloadFailed", "requestError", "bridgeError"}
        ]
        if failures:
            finish(False, "host failure: " + repr(failures[-1]))
            return

        metadata = next(
            (message for message in messages if message.get("type") == "waveformMetadata"),
            None,
        )
        if metadata is not None:
            signals = metadata.get("data", {}).get("signals", [])
            if any("changes" in signal for signal in signals):
                finish(False, "indexed metadata contains complete changes")
                return

        if "indexReady" not in types:
            QTimer.singleShot(100, inspect)
            return
        if not state["primed"]:
            state["primed"] = True
            view.page().runJavaScript(
                "window.__veriflowWaveViewer && window.__veriflowWaveViewer.addFirstSignals(6);"
            )
            QTimer.singleShot(200, inspect)
            return

        windows = [message for message in messages if message.get("type") == "windowData"]
        values = [message for message in messages if message.get("type") == "cursorValues"]
        if not windows or not values:
            QTimer.singleShot(100, inspect)
            return
        total_records = 0
        kinds = set()
        for series in windows[-1].get("series", []):
            kinds.add(series.get("kind"))
            total_records += len(series.get("times", series.get("firstTimes", [])))
        if total_records > 32768:
            finish(False, f"window response exceeded record cap: {total_records}")
            return
        if not {"raw", "summary"}.issubset(kinds):
            finish(False, "expected raw and summary windows: " + repr(kinds))
            return

        if not state["search_requested"]:
            state["search_requested"] = True
            view.page().runJavaScript(
                "document.getElementById('changeSearchMode').value='rising';"
                "document.getElementById('nextChange').click();"
            )
            QTimer.singleShot(100, inspect)
            return
        if "searchResult" not in types:
            QTimer.singleShot(100, inspect)
            return
        if state["javascript_pending"]:
            return
        state["javascript_pending"] = True

        def checked(payload) -> None:
            state["javascript_pending"] = False
            try:
                page_state = json.loads(payload or "{}")
            except json.JSONDecodeError:
                finish(False, "invalid indexed viewer state: " + repr(payload))
                return
            if page_state.get("cursorA") != 5:
                finish(False, "indexed search did not move cursor: " + repr(page_state))
                return
            if not page_state.get("indexReady") or not page_state.get("progressHidden"):
                finish(False, "indexed ready controls are inconsistent: " + repr(page_state))
                return
            QApplication.processEvents()
            pixels = _grab_waveform_stats(view)
            if not pixels["ok"]:
                finish(False, "indexed waveform pixels are blank: " + repr(pixels))
                return
            screenshot = os.environ.get("VERIFLOW_SMOKE_SCREENSHOT")
            if screenshot:
                view.grab().save(screenshot)
            finish(
                True,
                f"records={total_records}; messages={types}; pixels={pixels}",
            )

        view.page().runJavaScript(
            "JSON.stringify(Object.assign({}, "
            "window.__veriflowWaveViewer ? window.__veriflowWaveViewer.state() : {}, {"
            "indexReady: !document.getElementById('goStart').disabled,"
            "progressHidden: document.getElementById('indexProgress').hidden"
            "}));",
            checked,
        )

    QTimer.singleShot(0, lambda: panel.open_vcd(source))
    QTimer.singleShot(100, inspect)
    QTimer.singleShot(15000, lambda: finish(False, "timeout; messages=" + repr(messages[-8:])))
    app.exec()
    temporary.cleanup()

    if result["ok"]:
        print("[OK] Indexed waveform viewer rendered; " + result["message"])
        return 0
    print("[ERROR] Indexed waveform viewer smoke test failed: " + result["message"])
    return 1


def main() -> int:
    if "--legacy" in sys.argv:
        sys.argv.remove("--legacy")
        return _legacy_main()
    return _indexed_main()


if __name__ == "__main__":
    raise SystemExit(main())

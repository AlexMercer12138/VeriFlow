# Waveform P1 Indexed Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-file/full-JSON waveform loading with cross-host disk indexes, background workers, window queries, multi-resolution rendering, cancellation, and stable automatic reload.

**Architecture:** Python and TypeScript independently implement the same versioned little-endian `.vfi` format and query contract. Python runs the store behind `QThread`/`QWebChannel`; VS Code runs it in `worker_threads`; the shared WebView consumes metadata and bounded window/value/search responses through a host-neutral transport.

**Tech Stack:** Python 3.10+, PySide6 QtWebEngine/QtWebChannel, TypeScript ES2020, Node worker_threads/fs/crypto, browser Canvas/JavaScript, pytest, Node assert.

---

## File Map

### Python index and host

- Create `src/domain/services/vcd_index_format.py`: format constants, packed logic values, record codecs, manifest validation.
- Create `src/domain/services/vcd_index_service.py`: streaming two-pass builder, summary pyramid, reader, window/value/search queries.
- Create `src/infrastructure/waveform_cache.py`: platform cache root, fingerprint, locks, atomic publication, LRU cleanup.
- Create `src/presentation/gui/widgets/waveform_bridge.py`: QThread worker and QWebChannel bridge.
- Modify `src/presentation/gui/widgets/waveform_viewer_panel.py`: static page lifecycle, bridge, worker, watcher, stable reload.
- Modify `src/presentation/gui/widgets/waveform_html.py`: static shared page and QWebChannel transport assets.

### TypeScript index and host

- Create `veriflow-vscode/src/core/vcdIndexFormat.ts`: exact TypeScript counterpart of Python record codecs.
- Create `veriflow-vscode/src/core/vcdIndex.ts`: streaming builder, summaries, reader, and query engine.
- Create `veriflow-vscode/src/core/waveformCache.ts`: fingerprint, locks, publication, and eviction.
- Create `veriflow-vscode/src/core/waveformWorker.ts`: worker-thread entry point and generation/request cancellation.
- Create `veriflow-vscode/src/core/waveformWorkerClient.ts`: typed worker lifecycle used by the provider.
- Modify `veriflow-vscode/src/waveformEditorProvider.ts`: metadata/window protocol, watcher, stable reload, disposal.

### Shared WebView

- Create `veriflow-vscode/media/waveform/viewer-transport.js`: VS Code, QWebChannel, and smoke transport adapters.
- Modify `veriflow-vscode/media/waveform/viewer-core.js`: packed-value decoder, window cache, request/generation helpers.
- Modify `veriflow-vscode/media/waveform/viewer.js`: metadata-only signals, async windows/values/search, summary rendering, progress/cancel/retry.
- Modify `veriflow-vscode/media/waveform/viewer.html`: progress/cancel/retry controls.
- Modify `veriflow-vscode/media/waveform/viewer.css`: stable loading and reload states.

### Tests and benchmark

- Create `tests/test_vcd_index.py`: Python format, builder, query, cache, worker-independent tests.
- Create `veriflow-vscode/src/test/waveformIndex.test.ts`: TypeScript format, builder, query, cache, worker tests.
- Create `tests/fixtures/waveform_index_expected.json`: cross-language logical golden results.
- Create `scripts/generate_waveform_benchmark.py`: deterministic scalable VCD generator.
- Create `scripts/benchmark_waveform_index.py`: benchmark runner and JSON report.
- Modify `tests/test_core_services.py`: static page and bridge contract tests.
- Modify `tests/waveform_viewer_smoke.py`: indexed window, reload generation, layout, progress, and cancellation smoke checks.
- Modify `veriflow-vscode/package.json`: execute the new Node test and benchmark entry points.

### Task 1: Python Index Format and Packed Values

**Files:**
- Create: `src/domain/services/vcd_index_format.py`
- Create: `tests/test_vcd_index.py`

- [ ] **Step 1: Write failing packed-value and manifest tests**

Test `pack_logic_value`, `unpack_logic_value`, raw record round trips, summary record round trips, unsupported timestamps, and manifest version rejection. Use widths 1, 4, 9, and 32 and values containing X/Z.

```python
def test_logic_value_round_trip() -> None:
    packed = pack_logic_value("10xz", 4)
    assert packed == bytes([0b11_10_01_00])
    assert unpack_logic_value(packed, 4) == "10xz"
    assert unpack_logic_value(pack_logic_value("x", 9), 9) == "x" * 9


def test_raw_record_round_trip() -> None:
    codec = RawRecordCodec(width=4)
    record = codec.encode(2**40 + 7, "10xz")
    assert codec.decode(record) == (2**40 + 7, "10xz")


def test_manifest_rejects_unknown_version() -> None:
    with pytest.raises(VcdIndexError, match="version"):
        validate_manifest({"formatVersion": 99})
```

- [ ] **Step 2: Run RED**

Run: `python -m pytest tests/test_vcd_index.py -q`.

Expected: import failure for `src.domain.services.vcd_index_format`.

- [ ] **Step 3: Implement the exact format primitives**

Define `INDEX_VERSION = 1`, `DATA_MAGIC = b"VFI1"`, two-bit symbols `0=0, 1=1, X=2, Z=3`, `RawRecordCodec`, `SummaryRecordCodec`, `VcdIndexError`, and `validate_manifest`. Use unsigned little-endian 64-bit timestamps and reject values above `2**53 - 1` when converting for WebView output.

- [ ] **Step 4: Run GREEN and commit**

Run: `python -m pytest tests/test_vcd_index.py -q`.

```powershell
git add -- src/domain/services/vcd_index_format.py tests/test_vcd_index.py
git commit -m "feat: define waveform index format"
```

### Task 2: TypeScript Format Conformance

**Files:**
- Create: `veriflow-vscode/src/core/vcdIndexFormat.ts`
- Create: `veriflow-vscode/src/test/waveformIndex.test.ts`
- Modify: `veriflow-vscode/package.json`

- [ ] **Step 1: Write failing TypeScript codec tests**

Assert the same bytes and decoded values as Task 1, including the exact `10xz` packed byte, raw record bytes, summary flags, and version errors.

- [ ] **Step 2: Register and run RED**

Change the test script to:

```json
"test": "npm run compile && node ./out/test/core.test.js && node ./out/test/waveformIndex.test.js"
```

Run: `npm test` from `veriflow-vscode`.

Expected: compile failure for `../core/vcdIndexFormat`.

- [ ] **Step 3: Implement TypeScript codecs**

Export `INDEX_VERSION`, `DATA_MAGIC`, `packLogicValue`, `unpackLogicValue`, `RawRecordCodec`, `SummaryRecordCodec`, and `validateManifest`. Use `Buffer.writeBigUInt64LE` and reject WebView timestamps beyond `Number.MAX_SAFE_INTEGER`.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test` from `veriflow-vscode`.

```powershell
git add -- veriflow-vscode/src/core/vcdIndexFormat.ts veriflow-vscode/src/test/waveformIndex.test.ts veriflow-vscode/package.json
git commit -m "feat: add TypeScript waveform index format"
```

### Task 3: Python Two-Pass Index Builder

**Files:**
- Create: `src/domain/services/vcd_index_service.py`
- Modify: `tests/test_vcd_index.py`
- Create: `tests/fixtures/waveform_index_expected.json`

- [ ] **Step 1: Write failing builder tests**

Build `tests/fixtures/waveform_debug.vcd` and assert metadata arrives before build completion, aliases share streams, declared signals remain present, raw offsets do not overlap, end time is 20, timescale is `10ns`, and temporary files are absent after publication.

The expected JSON records logical metadata and these raw query results:

```json
{
  "timescale": "10ns",
  "endTime": 20,
  "clk": [[0, "0"], [5, "1"], [10, "0"], [15, "1"], [20, "0"]],
  "data": [[0, "0000"], [6, "1010"], [12, "10xz"], [18, "0011"]]
}
```

- [ ] **Step 2: Run RED**

Run: `python -m pytest tests/test_vcd_index.py -q`.

Expected: missing `build_vcd_index`.

- [ ] **Step 3: Implement streaming pass 1 and metadata callback**

Parse line-by-line from a binary file with incremental UTF-8 decoding. Reproduce current directive, scope, `$var`, scalar, vector, alias, warning, declared-without-change, and end-time behavior. Invoke `on_metadata` immediately after `$enddefinitions` and continue counting one record per identifier change.

- [ ] **Step 4: Implement positioned pass-2 writes**

Precompute stream offsets, truncate `waveform.vfi`, and use a bounded LRU of per-stream byte buffers. Flush each buffer to its assigned position. Check a cancellation callback between input chunks and flush batches. Write a temporary manifest only after raw data is complete.

- [ ] **Step 5: Run GREEN and commit**

Run: `python -m pytest tests/test_vcd_index.py -q`.

```powershell
git add -- src/domain/services/vcd_index_service.py tests/test_vcd_index.py tests/fixtures/waveform_index_expected.json
git commit -m "feat: build Python waveform indexes"
```

### Task 4: Python Summaries and Query Engine

**Files:**
- Modify: `src/domain/services/vcd_index_service.py`
- Modify: `tests/test_vcd_index.py`

- [ ] **Step 1: Write failing reader/query tests**

Test raw windows, boundary values, full-range summary selection, `2 * pixelWidth` caps, cursor values, all five search modes, bus-bit edges, cancellation during scan, X/Z summary flags, and exact timestamp precision rejection.

- [ ] **Step 2: Run RED**

Expected: missing `VcdIndexReader.query_window`, `values_at`, and `search`.

- [ ] **Step 3: Implement the 8:1 pyramid**

Append fixed summary records after raw data, store level offsets/counts/codecs in the manifest, and propagate first/last values plus changed/X/Z/dense flags. Geometric levels stop when each stream has at most one record.

- [ ] **Step 4: Implement reader queries**

Memory-map or positioned-read the data file, binary-search fixed records, include the value immediately preceding a raw window, select a summary level by pixel budget, and return Base64-packed value payloads. Cursor and search queries use raw records only.

- [ ] **Step 5: Run GREEN and commit**

Run: `python -m pytest tests/test_vcd_index.py -q`.

```powershell
git add -- src/domain/services/vcd_index_service.py tests/test_vcd_index.py
git commit -m "feat: query Python waveform indexes"
```

### Task 5: TypeScript Builder, Summaries, and Queries

**Files:**
- Create: `veriflow-vscode/src/core/vcdIndex.ts`
- Modify: `veriflow-vscode/src/test/waveformIndex.test.ts`

- [ ] **Step 1: Write failing TypeScript conformance tests**

Build the same fixture and compare metadata/raw queries to `waveform_index_expected.json`. Add the same window, summary, cursor, search, bus-bit, cancellation, and X/Z assertions used by Python.

- [ ] **Step 2: Run RED**

Run: `npm test` from `veriflow-vscode`.

Expected: compile failure for `../core/vcdIndex`.

- [ ] **Step 3: Implement streaming two-pass builder**

Use `fs.createReadStream`, `readline`, `FileHandle.truncate`, positioned `FileHandle.write`, and a bounded per-stream buffer LRU. Emit metadata and rate-limited progress callbacks. Keep manifest field names and record bytes compatible with Python.

- [ ] **Step 4: Implement summaries and reader**

Mirror Task 4 APIs as `buildVcdIndex`, `VcdIndexReader.queryWindow`, `valuesAt`, and `search`. Return the shared protocol payload types.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test` from `veriflow-vscode`.

```powershell
git add -- veriflow-vscode/src/core/vcdIndex.ts veriflow-vscode/src/test/waveformIndex.test.ts
git commit -m "feat: build and query TypeScript waveform indexes"
```

### Task 6: Cross-Host Cache Managers

**Files:**
- Create: `src/infrastructure/waveform_cache.py`
- Create: `veriflow-vscode/src/core/waveformCache.ts`
- Modify: `tests/test_vcd_index.py`
- Modify: `veriflow-vscode/src/test/waveformIndex.test.ts`

- [ ] **Step 1: Write failing cache tests in both languages**

Use temporary roots to verify identical fingerprint components, valid-index reuse, head/tail rewrite invalidation, exclusive locks, stale-lock recovery, atomic rename, cancellation cleanup, active-entry protection, and LRU eviction below a configured byte cap.

- [ ] **Step 2: Run both suites RED**

Run `python -m pytest tests/test_vcd_index.py -q` and `npm test`.

- [ ] **Step 3: Implement platform roots and fingerprints**

Normalize Windows paths to lower-case forward-slash form, use nanosecond stat data, hash first/last 64 KiB, and include index version. Store access timestamps in the manifest and update them without changing index identity.

- [ ] **Step 4: Implement lock/publication/eviction**

Use exclusive file creation, PID/timestamp/heartbeat lock content, stale-owner recovery, temporary build directories, atomic rename, and LRU cleanup. Expose `getOrBuild(source, callbacks, cancel)` and `openExisting(source)`.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- src/infrastructure/waveform_cache.py veriflow-vscode/src/core/waveformCache.ts tests/test_vcd_index.py veriflow-vscode/src/test/waveformIndex.test.ts
git commit -m "feat: cache waveform indexes"
```

### Task 7: Python Worker and QWebChannel Bridge

**Files:**
- Create: `src/presentation/gui/widgets/waveform_bridge.py`
- Modify: `src/presentation/gui/widgets/waveform_viewer_panel.py`
- Modify: `src/presentation/gui/widgets/waveform_html.py`
- Modify: `tests/test_core_services.py`

- [ ] **Step 1: Write failing bridge lifecycle tests**

Test generation increments, metadata-before-ready ordering, progress throttling, bounded window responses, request cancellation, build cancellation, disposal, and structured errors using a fake store. Add HTML assertions for QWebChannel and `viewer-transport.js`.

- [ ] **Step 2: Run RED**

Run: `python -m pytest tests/test_core_services.py -q`.

Expected: missing `WaveformBridge` and transport asset.

- [ ] **Step 3: Implement worker and bridge**

Create a worker `QObject` with build/query/cancel/close slots and JSON response signals. Move it to a `QThread`. Expose a GUI-thread QWebChannel object whose `send(str)` slot validates messages and queues worker operations. Never call the index service on the GUI thread.

- [ ] **Step 4: Convert the panel to one static page**

Install `QWebChannel` before loading HTML, send `openFile` through the bridge, keep the page alive across opens, cancel the prior generation, and dispose the thread on widget destruction. Remove full file reading and `_build_waveform_html(..., data)` from `open_vcd`.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- src/presentation/gui/widgets/waveform_bridge.py src/presentation/gui/widgets/waveform_viewer_panel.py src/presentation/gui/widgets/waveform_html.py tests/test_core_services.py
git commit -m "feat: stream indexed waveforms into Qt"
```

### Task 8: VS Code Worker and Provider Protocol

**Files:**
- Create: `veriflow-vscode/src/core/waveformWorker.ts`
- Create: `veriflow-vscode/src/core/waveformWorkerClient.ts`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Modify: `veriflow-vscode/src/test/waveformIndex.test.ts`

- [ ] **Step 1: Write failing worker-client tests**

Start a real Node worker on the fixture and assert metadata, progress, ready, window, values, search, cancellation, generation replacement, and disposal. Verify no message returns for a cancelled request.

- [ ] **Step 2: Run RED**

Run: `npm test`.

Expected: missing worker modules.

- [ ] **Step 3: Implement worker entry and client**

The worker owns cache/store handles and cancellation tokens. The client assigns generation/request IDs, filters stale responses, and terminates on disposal. It forwards serializable shared-protocol objects only.

- [ ] **Step 4: Integrate the provider**

Replace `_loadVcd` full reads with `WaveformWorkerClient.open(uri.fsPath)`. Forward WebView queries/cancellation/save-layout messages, post worker events to WebView, and terminate resources when the editor panel disposes.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- veriflow-vscode/src/core/waveformWorker.ts veriflow-vscode/src/core/waveformWorkerClient.ts veriflow-vscode/src/waveformEditorProvider.ts veriflow-vscode/src/test/waveformIndex.test.ts
git commit -m "feat: run waveform indexes in VS Code workers"
```

### Task 9: Shared Transport and Metadata-Only Viewer State

**Files:**
- Create: `veriflow-vscode/media/waveform/viewer-transport.js`
- Modify: `src/presentation/gui/widgets/waveform_html.py`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Modify: `veriflow-vscode/media/waveform/viewer-core.js`
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/test_core_services.py`

- [ ] **Step 1: Write failing transport/core tests**

Test transport selection for VS Code, QWebChannel, and memory harness; generation/request ID sequencing; stale response rejection; Base64 packed-value decode; and bounded window-cache eviction.

- [ ] **Step 2: Run RED**

Run Python shared-HTML tests and `npm test`.

- [ ] **Step 3: Implement transport and include it in both hosts**

Expose `waveformTransport.send`, `onMessage`, and `dispose`. Python HTML loads `qrc:///qtwebchannel/qwebchannel.js`; both hosts inline `viewer-transport.js` before `viewer.js`.

- [ ] **Step 4: Add indexed metadata state**

Handle `waveformMetadata` without `changes`, retain legacy `vcd`, track generation, reconcile layouts, clear stale data caches, and request the first visible window only after `indexReady`.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- veriflow-vscode/media/waveform/viewer-transport.js veriflow-vscode/media/waveform/viewer-core.js veriflow-vscode/media/waveform/viewer.js src/presentation/gui/widgets/waveform_html.py veriflow-vscode/src/waveformEditorProvider.ts tests/test_core_services.py
git commit -m "feat: add indexed waveform transport"
```

### Task 10: Async Window Rendering, Values, and Search

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer-core.js`
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Extend smoke checks and run RED**

Require metadata to arrive without complete changes, window requests to remain bounded, raw and summary rendering to produce nonblank pixels, cursor values to arrive asynchronously, every search mode to return through host protocol, and stale requests to be ignored.

- [ ] **Step 2: Implement 50 ms request scheduling and prefetch**

Compute visible stream keys from virtualized rows, request current range plus half-range margins, cancel prior view requests, and keep a bounded cache keyed by generation/stream/range/level.

- [ ] **Step 3: Render raw and summary payloads**

Decode packed values, preserve the boundary value before window start, draw scalar/bus summary flags, derive expanded bits from parent values, and show stable per-row loading placeholders.

- [ ] **Step 4: Migrate values and search**

Batch visible-row cursor values, store responses by request ID, disable controls before ready, send search conditions/bit indices to the host, and apply successful results to the active cursor and viewport.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- veriflow-vscode/media/waveform/viewer-core.js veriflow-vscode/media/waveform/viewer.js tests/waveform_viewer_smoke.py
git commit -m "feat: render indexed waveform windows"
```

### Task 11: Progress, Cancellation, and Retry UI

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer.html`
- Modify: `veriflow-vscode/media/waveform/viewer.css`
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/test_core_services.py`
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Write failing control/state tests**

Assert stable progress dimensions, phase/percent/MiB text, icon cancel button, retry state, initial-load overlay, nonblocking reload progress, disabled query controls, and cancellation leaving no temporary directory.

- [ ] **Step 2: Run RED**

Run shared HTML and smoke tests.

- [ ] **Step 3: Implement controls and state machine**

Use fixed-height progress elements, `aria-valuenow`, an icon button with tooltip, and a retry command. Handle `indexProgress`, `indexReady`, cancellation, and failure without resizing waveform rows or toolbar controls.

- [ ] **Step 4: Run GREEN and commit**

```powershell
git add -- veriflow-vscode/media/waveform/viewer.html veriflow-vscode/media/waveform/viewer.css veriflow-vscode/media/waveform/viewer.js tests/test_core_services.py tests/waveform_viewer_smoke.py
git commit -m "feat: show waveform indexing progress"
```

### Task 12: Stable Automatic Reload

**Files:**
- Modify: `src/presentation/gui/widgets/waveform_viewer_panel.py`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Modify: `tests/waveform_viewer_smoke.py`
- Modify: `veriflow-vscode/src/test/waveformIndex.test.ts`

- [ ] **Step 1: Write failing stable-reload tests**

Rewrite a temporary VCD in several writes, assert no reload while size/mtime change, assert one reload after 750 ms plus two stable observations, keep old queries working, reject stale generations, preserve layout/cursors by physical time, and retain old data on failure/cancel.

- [ ] **Step 2: Run RED**

Run Node worker tests and Qt smoke.

- [ ] **Step 3: Implement Python watcher**

Use `QFileSystemWatcher` and timers, re-add atomically replaced paths, compare size/mtime twice, cancel a build on another change, and open a new generation while retaining the old bridge store.

- [ ] **Step 4: Implement VS Code watcher**

Create a file watcher scoped to the document URI, debounce/stability-check with stat, cancel builds on new changes, and dispose watcher/timers with the panel.

- [ ] **Step 5: Run GREEN and commit**

```powershell
git add -- src/presentation/gui/widgets/waveform_viewer_panel.py veriflow-vscode/src/waveformEditorProvider.ts tests/waveform_viewer_smoke.py veriflow-vscode/src/test/waveformIndex.test.ts
git commit -m "feat: reload stable waveform files"
```

### Task 13: Benchmark Generator and Performance Report

**Files:**
- Create: `scripts/generate_waveform_benchmark.py`
- Create: `scripts/benchmark_waveform_index.py`
- Modify: `veriflow-vscode/package.json`
- Modify: `tests/test_vcd_index.py`

- [ ] **Step 1: Write failing deterministic-generator test**

Generate a small file twice and assert byte-identical output, requested signal/change counts, X/Z injection, aliases, and declared signals. Verify benchmark JSON contains source bytes, changes, metadata latency, build time, index bytes, warm/cold query percentiles, cancel latency, and peak memory where measurable.

- [ ] **Step 2: Run RED**

Run the new Python test; expect missing generator module.

- [ ] **Step 3: Implement generator and benchmark**

Stream output without retaining the VCD, support `--target-bytes`, `--changes`, `--signals`, and `--seed`, and write reports atomically. Add `benchmark:waveform` scripts for reduced and full targets.

- [ ] **Step 4: Run reduced benchmark and commit**

Run:

```powershell
python scripts/generate_waveform_benchmark.py --target-bytes 10485760 --output .tmp-waveform-benchmark.vcd
python scripts/benchmark_waveform_index.py .tmp-waveform-benchmark.vcd --output .tmp-waveform-report.json
```

Verify bounded responses and successful report, then remove generated ignored temporary files.

```powershell
git add -- scripts/generate_waveform_benchmark.py scripts/benchmark_waveform_index.py tests/test_vcd_index.py veriflow-vscode/package.json
git commit -m "perf: add waveform index benchmark"
```

### Task 14: Full Verification and Acceptance Audit

**Files:**
- Verify all P1 files and `docs/superpowers/specs/2026-07-19-waveform-p1-indexed-loading-design.md`.

- [ ] **Step 1: Run Python tests**

Run: `python -m pytest`.

Expected: all tests pass; desktop smoke remains explicitly run separately.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test` from `veriflow-vscode`.

Expected: TypeScript compilation and both test executables pass.

- [ ] **Step 3: Run Qt indexed/reload smoke**

Run: `python tests/waveform_viewer_smoke.py tests/fixtures/waveform_debug.vcd`.

Expected: metadata, raw/summary windows, values, search, layout, reload generation, rendering pixels, and cleanup pass.

- [ ] **Step 4: Run reduced performance verification**

Generate 10 MB input and verify the JSON report, cancellation latency, cache reuse, response caps, and no temporary build directories.

- [ ] **Step 5: Audit scope and worktree**

Run:

```powershell
git diff --check
git status --short
git diff --stat cf8e145..HEAD
```

Confirm each acceptance criterion has a unit, integration, smoke, or benchmark assertion. Preserve the user's existing `.gitignore` modification and removed `vlib.py` files.

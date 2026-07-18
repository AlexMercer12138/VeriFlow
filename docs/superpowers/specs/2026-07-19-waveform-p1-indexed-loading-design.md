# Waveform P1 Indexed Loading Design

## Goal

Implement the complete P1 waveform performance scope for both the Python Qt application and the VS Code extension:

- Parse and index VCD files outside UI/extension-host threads.
- Report progress and support cancellation.
- Reload automatically after a changed file becomes stable.
- Serve only the requested time window and signals to the WebView.
- Use multi-resolution summaries for zoomed-out rendering.
- Reuse versioned disk indexes from a bounded user cache.

The primary performance target is a 500 MB VCD containing 10 million value changes.

## Current State

The Python viewer reads the complete file, parses it synchronously in `WaveformViewerPanel.open_vcd()`, serializes every change to JSON, and embeds the payload into generated HTML. The VS Code provider reads the complete file, parses it synchronously in the extension host, and posts the complete `VcdData` object to the WebView.

The shared WebView stores every signal's complete `changes` array. Rendering, cursor values, and conditional search all operate directly on those arrays. Moving parsing to a worker without changing this data model would remove some UI blocking but would not solve peak memory, serialization cost, or WebView heap growth.

## Scope

This design covers the complete P1 implementation in one delivery. It does not add FST, protocol decoders, waveform comparison, live tailing of a growing file, or network/remote cache sharing.

Automatic reload starts only after the source file size and modification time remain stable. Real-time parsing while a simulator is still appending VCD content is out of scope.

## Architecture

### Shared query contract

Introduce a host-independent `WaveformStore` contract with these operations:

- Publish file and signal metadata as soon as the declaration section is parsed.
- Return waveform samples for a set of signals, a time range, and a pixel budget.
- Return exact values for a set of signals at one or more cursor times.
- Find the previous or next match for change, rising edge, falling edge, exact value, or X/Z.
- Report index progress and readiness.
- Cancel an index build or an individual query.
- Close all files, mappings, workers, and temporary resources.

The Python and TypeScript implementations must return the same logical results for the same source file. The WebView communicates only through the shared message protocol and does not depend on host-specific parser types.

### Python host

Python uses a dedicated `QObject` worker moved to a `QThread` for streaming parse, index construction, and index queries. A `QWebChannel` bridge carries JSON messages between the shared page and the Python host. The page is loaded once; opening or reloading a VCD no longer regenerates HTML containing waveform data.

The worker emits metadata, progress, response, ready, cancellation, and failure signals. Closing the panel or opening another file requests cooperative cancellation and waits for worker cleanup without blocking the GUI event loop.

### VS Code host

VS Code uses `worker_threads.Worker` for streaming parse, index construction, and queries. The extension host owns the file watcher and forwards typed messages between the worker and WebView. It never receives a complete decoded change set.

The existing `VcdParser.parse(text)` remains available for existing unit tests and non-viewer callers. The indexed viewer uses the new file-oriented worker API.

### Existing parser compatibility

`VcdParserService.parse(text)` and `VcdParser.parse(text)` remain behaviorally compatible. New indexed parsers share fixture expectations with them but do not require callers to migrate. This confines P1 changes to waveform-viewer loading and avoids unrelated service refactoring.

## Generation Model

Every open, reload, or retry creates a monotonically increasing generation. Every metadata, progress, ready, window, value, search, cancellation, and failure message carries that generation. Query messages also carry a request ID.

The WebView accepts a response only when both generation and request ID match its current state. A reload keeps the previous complete store active until the new generation is ready. Switching generations is atomic from the WebView's perspective: clear data caches, install new metadata, reconcile layout, restore the physical time view, then request the visible window.

## Cache Location and Identity

### Cache roots

- Windows: `%LOCALAPPDATA%/VeriFlow/waveform-cache`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/veriflow/waveform-cache`
- macOS: `~/Library/Caches/VeriFlow/waveform-cache`

Both hosts resolve the same platform path so an index built by one host can be reused by the other.

### Source fingerprint

The cache key is SHA-256 over:

- A normalized absolute source path.
- File size.
- Nanosecond modification time when available.
- SHA-256 of the first 64 KiB.
- SHA-256 of the last 64 KiB.
- Index-format version.

The content samples protect against a simulator rewriting a file to the same length with an unchanged or coarse modification timestamp.

### Cache layout

```text
<cache-root>/<fingerprint>/
  manifest.json
  waveform.vfi
```

Builds use `<fingerprint>.tmp.<pid>.<nonce>` and create the final directory only through atomic rename after all files are flushed and validated. Cancellation and failure remove the temporary directory.

An exclusive lock file prevents Python and VS Code from building the same fingerprint concurrently. A second process waits for the final manifest and reports waiting progress. A lock is stale when its owning process is absent or its heartbeat has exceeded the implementation timeout; stale locks are reclaimed safely.

### Eviction

The default cache limit is 4 GB and is configurable from 1 through 64 GB. Completed indexes record last-access time. Cleanup runs on startup and after successful index publication, removing least-recently-used entries until the limit is satisfied. Active indexes, temporary builds with valid locks, and the source currently being opened are never evicted.

Each host also maintains a 64 MB LRU cache of decoded index blocks. The WebView caches only the current window and half a window of prefetch on either side, with a target heap increase below 128 MB at the primary benchmark.

## Binary Index Format

The index format is explicitly versioned and little-endian. `manifest.json` contains source fingerprint data, VCD metadata, scopes, signal declarations, alias-to-stream mappings, stream offsets/counts/record sizes, summary-level tables, and integrity information for `waveform.vfi`.

### Value streams

Signals sharing a VCD identifier share one value stream. Signal declarations retain their own name, scope, type, width, and occurrence identity but refer to the shared stream. This preserves alias behavior without duplicating changes.

Each raw record has fixed width for its stream:

- Unsigned 64-bit timestamp.
- Signal value encoded with two bits per declared bit: `0`, `1`, `X`, or `Z`.

Vector values are normalized to declared width using the same padding behavior in both hosts. Signals with no source changes use the existing default-X behavior and allocate no raw records.

Timestamps are decoded to JavaScript numbers only after verifying they do not exceed the supported exact integer range. An unsupported timestamp produces a structured parse error rather than silent precision loss.

### Two-pass construction

1. Stream the declaration section and publish metadata immediately.
2. Continue the first pass to validate changes and count records per identifier.
3. Compute contiguous raw-stream offsets from record counts and widths.
4. Stream the source a second time and write each record directly to its assigned location.
5. Build multi-resolution summaries by reading completed raw streams.
6. Flush files, write the final manifest and integrity data, validate, and atomically publish the cache directory.

The implementation reads bounded chunks and retains only parser carry-over, declaration tables, counters, write cursors, and bounded block buffers in memory.

## Multi-Resolution Summaries

Each value stream has an 8:1 summary pyramid. A level-1 record summarizes up to eight raw records; each following level summarizes up to eight records from the previous level.

A summary record contains:

- First and last timestamp.
- First and last packed value.
- Flags indicating any transition, X, Z, and dense activity inside the span.

The query engine chooses the finest level whose result fits the response budget, targeting no more than approximately `2 * pixelWidth` records per requested signal. When the raw range already fits the budget, raw records are returned. Summaries preserve boundary values and X/Z visibility but are never used for exact cursor values or conditional search.

Scalar rendering uses summary transition and state flags. Bus rendering uses first/last values and dense-activity flags; value labels are shown only when the returned span is wide enough. Expanded bus bits reuse the parent bus payload and are decoded in the WebView.

## Shared Message Protocol

The shared page calls `waveformTransport.send(message)`. VS Code wraps `acquireVsCodeApi().postMessage()`. Python wraps `QWebChannel`. The smoke harness uses an in-memory transport.

### WebView to host

- `ready`
- `openFile`
- `windowRequest`
- `valueRequest`
- `searchRequest`
- `cancelRequest`
- `cancelLoad`
- `retryLoad`
- `saveLayout`

### Host to WebView

- `waveformMetadata`
- `indexProgress`
- `indexReady`
- `windowData`
- `cursorValues`
- `searchResult`
- `reloadFailed`

All messages contain `generation`. Query messages and responses contain `requestId`. Progress includes phase, completed bytes or records, total work when known, and percentage when calculable.

### Window payload

A `windowRequest` contains signal stream keys, optional bus-bit selections, start/end ticks, canvas width, and the current prefetch policy. The response contains one entry per requested stream with raw or summary kind, width, numeric timestamps, packed values encoded as Base64, and summary flags where applicable.

Single-response size has a hard limit. If a selected level would exceed the limit, the query engine selects a coarser level or partitions the response without exceeding the request's generation and cancellation contract.

The legacy one-shot `vcd` message remains accepted for one compatibility version and test migration. Normal file loading never uses it.

## WebView Data Model

Signal declarations no longer contain complete `changes` arrays. The shared viewer maintains:

- Metadata and layout state.
- Current generation and pending request IDs.
- A bounded raw/summary window cache.
- A map of values for currently rendered library and waveform rows at the active cursor.
- Loading and reload state.

Rendering requests data for visible waveform rows after a 50 ms debounce. A new navigation request cancels the previous request for that view. The viewer prefetches half a visible time span before and after the requested range.

Cursor-value requests include only rendered library rows and displayed waveform rows. Conditional search is performed by the host against raw records and supports the current modes and bus-bit semantics. Successful results update the active cursor and viewport exactly as the current viewer does.

Grouping, ordering, colors, radix, display names, column widths, layout persistence, and A/B cursor ownership remain in the WebView.

## Loading and Cancellation UX

### Initial load

After declarations are parsed, the signal library and scopes become usable. Until indexed waveform data is ready, the waveform pane shows a stable loading state and the status area shows phase, percentage, processed MiB, and an icon button for cancellation. Progress messages are limited to ten per second.

Cursor-value and search controls remain disabled until the complete index is validated and published. Cancellation preserves metadata, removes the temporary index, and exposes a retry command.

### Reload

During reload, the existing waveform remains fully interactive. Progress appears in the status area without covering the waveform. Cancellation or failure preserves the old generation.

When the new generation becomes ready, layout signals are reconciled by full name, width, reference, and occurrence. View start/end and A/B cursor positions are converted through physical seconds when old and new timescales are recognized, then clamped to the new range.

### Stable-file detection

Python uses `QFileSystemWatcher`; VS Code uses its file-system watcher. A change starts a 750 ms debounce. Before building, the host confirms size and modification time are unchanged across two observations. A change during construction cancels that generation and returns to stable-file waiting.

Python re-registers the watcher when a simulator replaces the file atomically. Deletion or truncation retains the old generation and reports the source condition.

## Error Handling

- Unsupported or corrupt cache: remove it and rebuild.
- Corrupt final manifest or data checksum: never publish it to the viewer.
- Source change during build: cancel and restart after stability.
- File deletion/truncation during reload: retain old data and report failure.
- Disk-full or permission error: stop writing, remove temporary files, and report the cache path.
- Worker exception: close resources and emit a structured failure.
- Panel disposal: cancel workers, queries, timers, watchers, channels, and locks.
- Stale generation or request response: discard silently in the WebView.
- Query cancellation: check between block reads and scan batches so work stops promptly.

## Testing Strategy

### Unit and conformance tests

- Scalar, vector, X/Z, aliases, declared-without-change signals, directive variants, and large timestamps.
- Index manifest validation, raw offsets, packed values, summary records, and corrupt/truncated files.
- Python and TypeScript build the same fixtures and are compared for metadata, window queries, cursor values, and search results.
- Cache fingerprints, reuse, LRU eviction, locks, stale locks, atomic publication, cancellation cleanup, and disk errors.
- Worker progress, cancellation, generation replacement, disposal, and source changes.
- WebView transport, Base64 decoding, window cache, prefetch, level selection, stale-response rejection, and layout preservation.

### Integration tests

- Python `QWebChannel` request/response behavior without a complete JSON payload.
- VS Code worker tests run under Node without requiring a VS Code host.
- QtWebEngine smoke loads a fixture, verifies data windows, modifies the source, waits for stable reload, and confirms generation switch while layout persists.
- Existing P0 cursor, search, layout, parser, and rendering checks remain active.

### Performance tests

A deterministic generator creates VCDs without committing large fixtures. CI uses a reduced dataset to exercise the same paths and enforce bounded response sizes. An explicit benchmark command generates the 500 MB / 10 million-change file and writes a JSON report.

## Acceptance Criteria

- For the 500 MB baseline, declarations near the file start appear with progress within 2 seconds.
- Python GUI and VS Code extension-host stalls remain below approximately 100 ms during build and queries.
- The WebView never receives the complete change set and stays within approximately 128 MB additional heap at the benchmark.
- A 32-signal, 1920-pixel window query targets under 100 ms from decoded cache and under 300 ms from cold local disk.
- Cancellation stops continued index writing within 500 ms and removes temporary output.
- A full-range response returns no more than approximately `2 * pixelWidth` records per signal.
- A valid cache is reused without rescanning the VCD.
- Reload keeps the previous generation queryable until atomic switch.
- Reload cancellation/failure leaves the previous waveform intact.
- Python and TypeScript conformance fixtures return equivalent metadata, values, searches, and windows.
- Existing waveform layout, cursor, condition-search, and rendering tests continue to pass.

## Implementation Sequence

The work is delivered as complete P1 but implemented in this order:

1. Shared format constants, fixtures, value encoding, index writer/reader, and query conformance.
2. Python worker, cache manager, query service, and QWebChannel bridge.
3. TypeScript worker, cache manager, query service, and provider integration.
4. Shared transport, metadata-only viewer state, window/value/search requests, and summary rendering.
5. Stable-file watchers, reload generation switching, cancellation UX, and cache eviction.
6. Cross-host integration, performance generator, benchmark reporting, and tuning.

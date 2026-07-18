# Waveform Debug Productivity Design

## Goal

Add three debugging features to the shared VeriFlow waveform viewer:

1. Persist and restore the waveform layout for each VCD file.
2. Replace the single cursor with A/B cursors and show delta time and frequency.
3. Search selected waveform signals by change, edge, exact value, or X/Z state.

The Python Qt viewer and VS Code custom editor must continue to use the same HTML, CSS, and JavaScript implementation.

## Current Architecture

The shared viewer lives in `veriflow-vscode/media/waveform/`. `viewer.js` currently owns both UI behavior and waveform algorithms. Python embeds these assets through `src/presentation/gui/widgets/waveform_html.py`; VS Code embeds them through `veriflow-vscode/src/waveformEditorProvider.ts`.

Both hosts send parsed VCD data to the page using a `vcd` window message. The viewer maintains added signals, group rows, display options, one cursor, and the visible time range entirely in memory.

## Chosen Approach

Create a small dependency-free `viewer-core.js` beside the existing viewer assets. It will expose pure functions through both `module.exports` and `globalThis.VeriflowWaveCore`. The pure module owns state validation, signal identity matching, time measurement, search-value normalization, and change matching. `viewer.js` remains responsible for DOM events, canvas rendering, and translating UI state to and from the core data structures.

This approach keeps the two hosts aligned and allows the important behavior to run under Node without constructing a browser DOM. Keeping all new logic in `viewer.js` was rejected because that file is already large and tightly coupled to the DOM. A framework rewrite was rejected as unrelated to the requested features.

## Layout Persistence

### Storage scope

Layouts are stored per VCD resource rather than as one global layout. A VS Code layout is keyed by `document.uri.toString()` in `ExtensionContext.workspaceState`. A Python layout is keyed by the full waveform file name in browser `localStorage`. Storage errors are non-fatal; the viewer continues with an empty layout and reports a concise status message only when a user-visible save or restore fails.

VS Code is the authoritative persistent store for its host. Its `vcd` message includes any stored layout, and the page sends a debounced `saveLayout` message after state changes. The page may also use `acquireVsCodeApi().setState()` as a same-panel recovery cache, but workspace state is what supports closing and reopening the file. Python uses local storage directly because it has no webview message bridge.

### Versioned state

The stored document has `version: 1` and contains:

- Ordered group and signal rows.
- Group names, identifiers, membership, and expanded state.
- Signal color, radix, short/full-name mode, custom display name, and bus-expanded state.
- Signal-library width and waveform-name width.
- Visible start/end time and vertical waveform scroll position.
- Cursor A time, optional cursor B time, and the active cursor.

Transient state is not stored: signal-library filters, context menus, drag state, selection rectangles, and selected waveform rows.

Signals are identified by full hierarchical name, width, reference, and declaration occurrence. The VCD identifier code is not persisted because simulators may assign different identifier codes on a later run. During restore, each descriptor consumes the first unused matching signal. Missing or changed signals are skipped without preventing the rest of the layout from loading. Unknown versions or malformed fields are ignored safely.

Restored times are clamped to the new VCD range. Column widths are clamped to the same minimum and maximum constraints used by interactive resizing. Saving is debounced and compares the serialized state with the last saved state so canvas rendering does not create redundant writes.

## A/B Cursor Measurement

Cursor A replaces the current single cursor and is initialized to the VCD start time. Cursor B begins unset. The toolbar contains compact A and B toggle buttons with `aria-pressed`; keyboard shortcuts `A` and `B` select the active cursor when focus is not in an input. Clicking the canvas, Go To, start/end navigation, and change search move the active cursor.

The canvas draws A and B as different colored dashed lines with labels. The status bar shows:

```text
A: 120 ns | B: 145 ns | Delta: 25 ns | 40 MHz
```

When B is unset, delta and frequency display `-`. When the cursors coincide, delta is zero and frequency displays `-` rather than infinity. Delta is absolute, so the measurement is independent of cursor order.

VCD timestamps are ticks. Measurement code parses both the multiplier and unit from timescales such as `1ns`, `10 ns`, and `100ps`. All cursor and range formatting will use that multiplier, correcting the existing display for non-unit timescales. Frequency is formatted in Hz, kHz, MHz, GHz, or THz, preferring a value from 1 through 999 when possible.

## Conditional Change Search

The existing previous/next-change buttons remain the navigation controls. A compact mode selector beside them chooses:

- Any change
- Rising edge
- Falling edge
- Exact value
- Any X/Z

The exact-value mode enables a value input. It accepts `0b`/`b` binary, `0x`/`h` hexadecimal, and unsigned decimal input; underscores and spaces are ignored. Values are normalized to the target width with leading zeros. Invalid or out-of-range input does not move a cursor and produces a status message.

A rising edge is a resolved `0` to `1` transition; a falling edge is `1` to `0`. Transitions involving X or Z do not count as edges. Edge search applies to scalar signals and expanded bus bits. X/Z search matches a change value containing either X or Z. Exact value search applies to both scalars and vectors.

Search targets follow these rules:

1. Clicking an expanded bus bit makes that bit the target without changing edit operations on its parent bus.
2. Otherwise, selected base waveform signals are the targets.
3. If no base waveform is selected, all added base waveform signals are targets.
4. Groups are never search targets.

For multiple targets, next search chooses the earliest matching timestamp after the active cursor; previous search chooses the latest timestamp before it. Ties are resolved by displayed waveform order. Search does not wrap at file boundaries. A successful search moves the active cursor, centers an off-screen result while preserving the current zoom span, selects the matched waveform or bus bit, refreshes displayed values, and reports the signal, condition, and time. No-match results leave the view unchanged and report the reached boundary.

The default mode is Any change, preserving the current previous/next behavior.

## UI Changes

The shared toolbar gains:

- A/B cursor toggle buttons.
- A condition selector.
- A value input visible only for Exact value mode.

The status bar replaces the single `Cursor:` field with the combined A/B measurement text. Toolbar controls remain keyboard accessible and use existing VS Code-themed styles. At narrow widths, the file title may shrink before navigation and search controls; controls must not overlap the canvas.

Bus-bit selection receives the same row highlight treatment as a selected base signal. Selecting a base signal, group, or multiple signals clears the active bus-bit target.

## Data Flow

1. A host parses a VCD and sends `{ type: "vcd", fileName, data, layout? }`.
2. `viewer.js` initializes the VCD model, asks `viewer-core.js` to validate and match any layout, applies the restored state, then renders once.
3. UI operations mutate in-memory state and schedule a debounced serialization.
4. VS Code receives `{ type: "saveLayout", layout }` and updates workspace state for the current document. Python writes the same document to local storage.
5. Search UI builds target descriptors and asks the core search routine for the nearest match relative to the active cursor.
6. The viewer applies a match to cursor, viewport, selection, status, and rendering state.

## Error Handling

- Missing storage, quota errors, malformed JSON, and unknown layout versions never prevent VCD display.
- A partially stale layout restores all signals that can still be matched.
- Invalid search input explains the accepted formats and leaves cursor and viewport unchanged.
- Edge search with only vector targets explains that a scalar or expanded bit is required.
- Search with no displayed signals asks the user to add a waveform signal first.
- Timescale parsing falls back to raw ticks when the VCD has no recognized timescale.

## Testing

Automated Node tests for `viewer-core.js` will cover:

- Versioned layout validation and rejection of malformed state.
- Stable signal matching, duplicate occurrences, and missing signals.
- Timescale multipliers, delta formatting, zero delta, and frequency units.
- Search-value parsing for binary, hexadecimal, decimal, width overflow, and X/Z.
- Next/previous matching, no wrapping, multi-signal tie ordering, scalar edges, bus-bit edges, vector values, and X/Z matches.

Shared HTML tests will verify that both hosts include the core script and required controls. The existing QtWebEngine smoke hook will be extended to exercise layout round-tripping, A/B measurement state, and representative search results. Existing parser, TypeScript, Python, and packaging tests remain part of final verification.

## Acceptance Criteria

- Reopening a VCD restores its last valid layout independently of other VCD files in both supported hosts.
- A and B can be positioned independently, survive layout restoration, and display correct delta/frequency for non-unit timescales.
- Previous/next navigation supports all five modes and follows target, ordering, boundary, and validation rules above.
- Default Any change behavior remains compatible with the existing viewer.
- A stale or corrupted layout cannot prevent a waveform from opening.
- Pure logic tests, VS Code compilation/tests, Python tests, and shared-viewer smoke checks pass.

## Out of Scope

This change does not add bookmarks, protocol decoders, live reload, FST support, background parsing, layout import/export, or cross-file/global default layouts.

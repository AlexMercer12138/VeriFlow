# Waveform Debug Productivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-VCD layout persistence, A/B cursor measurement, and conditional change search to the shared Python/VS Code waveform viewer.

**Architecture:** Put layout validation, time measurement, and search algorithms in a dependency-free UMD/CommonJS asset named `viewer-core.js`. Keep DOM/canvas integration in `viewer.js`; use a small testable TypeScript workspace-state store for VS Code and local storage for the Python-hosted page.

**Tech Stack:** JavaScript ES2020, TypeScript, VS Code Webview API, HTML/CSS canvas UI, Python/PySide6 QtWebEngine, Node `assert`, pytest.

---

## File Map

- Create `veriflow-vscode/media/waveform/viewer-core.js`: pure layout, measurement, and search functions usable by Node and the browser.
- Create `veriflow-vscode/src/core/waveformLayoutStore.ts`: per-resource wrapper around VS Code-compatible memento storage.
- Create `tests/fixtures/waveform_debug.vcd`: deterministic VCD for integration smoke checks.
- Modify `veriflow-vscode/src/test/core.test.ts`: unit tests for the core JavaScript module and TypeScript layout store.
- Modify `veriflow-vscode/src/waveformEditorProvider.ts`: inline the core asset and load/save layouts through workspace state.
- Modify `src/presentation/gui/widgets/waveform_html.py`: inline the core asset before `viewer.js` for Python.
- Modify `veriflow-vscode/media/waveform/viewer.html`: A/B controls and conditional-search controls.
- Modify `veriflow-vscode/media/waveform/viewer.css`: compact toolbar, active-cursor, search, and bus-bit selection styling.
- Modify `veriflow-vscode/media/waveform/viewer.js`: restore/save layout, render and navigate A/B cursors, and integrate conditional search.
- Modify `tests/test_core_services.py`: shared-asset and markup contract tests.
- Modify `tests/waveform_viewer_smoke.py`: browser-level layout, cursor, and search verification.

### Task 1: Versioned Layout Core

**Files:**
- Create: `veriflow-vscode/media/waveform/viewer-core.js`
- Modify: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Write failing layout-core tests**

Load the browser asset as CommonJS and add focused tests:

```typescript
type WaveCore = {
    validateLayout(value: unknown): any | null;
    describeSignal(signal: any, signals: any[]): any;
    matchSignalDescriptors(descriptors: any[], signals: any[]): Array<number | null>;
};

const waveCore = require('../../media/waveform/viewer-core.js') as WaveCore;

function testWaveLayoutValidationAndMatching(): void {
    const layout = waveCore.validateLayout({
        version: 1,
        rows: [{ kind: 'signal', signal: { fullName: 'top.a', reference: 'a', width: 1, occurrence: 0 } }],
        view: { startTime: 2, endTime: 8, waveScrollTop: 0, libraryWidth: 280, waveNameWidth: 160 },
        cursors: { a: 3, b: 7, active: 'b' },
    });
    assert.ok(layout);
    assert.strictEqual(waveCore.validateLayout({ version: 2, rows: [] }), null);
    assert.strictEqual(waveCore.validateLayout({ version: 1, rows: 'bad' }), null);

    const signals = [
        { fullName: 'top.a', reference: 'a', width: 1 },
        { fullName: 'top.a', reference: 'a', width: 1 },
        { fullName: 'top.data', reference: 'data', width: 8 },
    ];
    assert.deepStrictEqual(waveCore.describeSignal(signals[1], signals), {
        fullName: 'top.a', reference: 'a', width: 1, occurrence: 1,
    });
    assert.deepStrictEqual(waveCore.matchSignalDescriptors([
        { fullName: 'top.a', reference: 'a', width: 1, occurrence: 1 },
        { fullName: 'top.missing', reference: 'missing', width: 1, occurrence: 0 },
        { fullName: 'top.a', reference: 'a', width: 1, occurrence: 0 },
    ], signals), [1, null, 0]);
}
```

Register `testWaveLayoutValidationAndMatching` in the existing `tests` array.

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test` from `veriflow-vscode`.

Expected: TypeScript compilation succeeds, then Node fails because `media/waveform/viewer-core.js` does not exist.

- [ ] **Step 3: Implement the UMD shell and layout functions**

Expose this stable API:

```javascript
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.VeriflowWaveCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const LAYOUT_VERSION = 1;

    function validateLayout(value) {
        if (!value || value.version !== LAYOUT_VERSION || !Array.isArray(value.rows)) return null;
        const view = value.view && typeof value.view === 'object' ? value.view : {};
        const cursors = value.cursors && typeof value.cursors === 'object' ? value.cursors : {};
        return { version: LAYOUT_VERSION, rows: value.rows.filter(row => row && typeof row === 'object'), view, cursors };
    }

    function sameSignal(a, b) {
        return a.fullName === b.fullName && a.reference === b.reference && Number(a.width) === Number(b.width);
    }

    function describeSignal(signal, signals) {
        const occurrence = signals.slice(0, signals.indexOf(signal)).filter(item => sameSignal(item, signal)).length;
        return { fullName: signal.fullName, reference: signal.reference, width: Number(signal.width), occurrence };
    }

    function matchSignalDescriptors(descriptors, signals) {
        const used = new Set();
        return descriptors.map(descriptor => {
            let occurrence = -1;
            for (let index = 0; index < signals.length; index++) {
                if (!sameSignal(descriptor, signals[index])) continue;
                occurrence++;
                if (occurrence === Number(descriptor.occurrence || 0) && !used.has(index)) {
                    used.add(index);
                    return index;
                }
            }
            return null;
        });
    }

    return { LAYOUT_VERSION, validateLayout, describeSignal, matchSignalDescriptors };
});
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npm test` from `veriflow-vscode`.

Expected: all existing tests plus `wave layout validation and matching` print `ok`.

- [ ] **Step 5: Commit the layout core**

```powershell
git add -- veriflow-vscode/media/waveform/viewer-core.js veriflow-vscode/src/test/core.test.ts
git commit -m "feat: add waveform layout core"
```

### Task 2: Timescale and A/B Measurement Core

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer-core.js`
- Modify: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Write failing measurement tests**

Extend `WaveCore` and add:

```typescript
function testWaveCursorMeasurement(): void {
    assert.deepStrictEqual(waveCore.parseTimescale('10 ns'), {
        multiplier: 10, unit: 'ns', secondsPerTick: 1e-8,
    });
    assert.strictEqual(waveCore.formatTicks(12, '10ns'), '120 ns');
    assert.deepStrictEqual(waveCore.measureCursors(12, 17, '10ns'), {
        deltaTicks: 5, deltaText: '50 ns', frequencyText: '20 MHz',
    });
    assert.deepStrictEqual(waveCore.measureCursors(12, 12, '1ns'), {
        deltaTicks: 0, deltaText: '0 ns', frequencyText: '-',
    });
    assert.deepStrictEqual(waveCore.measureCursors(12, null, '1ns'), {
        deltaTicks: null, deltaText: '-', frequencyText: '-',
    });
}
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test` from `veriflow-vscode`.

Expected: failure reports `parseTimescale is not a function`.

- [ ] **Step 3: Implement measurement helpers**

Add unit-to-seconds conversion for `fs`, `ps`, `ns`, `us`, `ms`, and `s`; parse the optional integer multiplier; compact duration display across adjacent units; and format frequency with three significant digits and an appropriate SI unit. Export:

```javascript
return {
    LAYOUT_VERSION,
    validateLayout,
    describeSignal,
    matchSignalDescriptors,
    parseTimescale,
    formatTicks,
    measureCursors,
};
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `npm test` from `veriflow-vscode`.

Expected: the cursor measurement test prints `ok`; the full test process exits 0.

- [ ] **Step 5: Commit measurement logic**

```powershell
git add -- veriflow-vscode/media/waveform/viewer-core.js veriflow-vscode/src/test/core.test.ts
git commit -m "feat: add waveform cursor measurement core"
```

### Task 3: Conditional Search Core

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer-core.js`
- Modify: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Write failing value and search tests**

Use scalar, vector, and bit targets with deterministic changes:

```typescript
function testWaveConditionalSearch(): void {
    assert.deepStrictEqual(waveCore.parseSearchValue('0xA', 4), { ok: true, bits: '1010' });
    assert.deepStrictEqual(waveCore.parseSearchValue('0b0011', 4), { ok: true, bits: '0011' });
    assert.deepStrictEqual(waveCore.parseSearchValue('10', 8), { ok: true, bits: '00001010' });
    assert.strictEqual(waveCore.parseSearchValue('0x10', 4).ok, false);

    const clk = { order: 0, name: 'top.clk', width: 1, changes: [
        { time: 0, value: '0' }, { time: 5, value: '1' },
        { time: 10, value: '0' }, { time: 15, value: 'x' }, { time: 20, value: '1' },
    ] };
    const data = { order: 1, name: 'top.data', width: 4, changes: [
        { time: 0, value: '0000' }, { time: 6, value: '1010' },
        { time: 12, value: '10xz' }, { time: 18, value: '0011' },
    ] };
    const bit = { ...data, order: 2, name: 'top.data[1]', width: 1, bitIndex: 1, parentWidth: 4 };

    assert.strictEqual(waveCore.findSearchMatch([clk], 0, 1, 'rising', '').time, 5);
    assert.strictEqual(waveCore.findSearchMatch([clk], 12, -1, 'falling', '').time, 10);
    assert.strictEqual(waveCore.findSearchMatch([data], 0, 1, 'value', '0xA').time, 6);
    assert.strictEqual(waveCore.findSearchMatch([data], 6, 1, 'xz', '').time, 12);
    assert.strictEqual(waveCore.findSearchMatch([bit], 0, 1, 'rising', '').time, 6);
    assert.strictEqual(waveCore.findSearchMatch([clk, data], 0, 1, 'change', '').time, 5);
    assert.strictEqual(waveCore.findSearchMatch([clk], 20, 1, 'change', '').match, null);
}
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test` from `veriflow-vscode`.

Expected: failure reports `parseSearchValue is not a function`.

- [ ] **Step 3: Implement value parsing and nearest-match search**

Implement and export `parseSearchValue(text, width)` and `findSearchMatch(targets, cursorTime, direction, mode, query)`. Return `{ match: null, error: string }` for invalid input, missing targets, inapplicable edges, and boundaries; successful results contain `match`, `time`, `target`, and `value`. Compare candidate times first and `target.order` second, using ascending order for next and descending time with ascending display order for previous.

- [ ] **Step 4: Run and confirm GREEN**

Run: `npm test` from `veriflow-vscode`.

Expected: conditional-search tests and the complete test suite exit 0.

- [ ] **Step 5: Commit search core**

```powershell
git add -- veriflow-vscode/media/waveform/viewer-core.js veriflow-vscode/src/test/core.test.ts
git commit -m "feat: add waveform condition search core"
```

### Task 4: VS Code Per-Resource Layout Store

**Files:**
- Create: `veriflow-vscode/src/core/waveformLayoutStore.ts`
- Modify: `veriflow-vscode/src/test/core.test.ts`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`

- [ ] **Step 1: Write a failing store test**

Add a fake memento and verify independent resources survive merging:

```typescript
function testWaveformLayoutStore(): void {
    const values = new Map<string, unknown>();
    const memento = {
        get<T>(key: string, fallback: T): T { return (values.has(key) ? values.get(key) : fallback) as T; },
        update(key: string, value: unknown): Thenable<void> { values.set(key, value); return Promise.resolve(); },
    };
    const store = new WaveformLayoutStore(memento);
    return Promise.all([
        store.save('file:///a.vcd', { version: 1, rows: [{ kind: 'group' }] }),
        store.save('file:///b.vcd', { version: 1, rows: [{ kind: 'signal' }] }),
    ]).then(() => {
        assert.strictEqual((store.load('file:///a.vcd') as any).rows[0].kind, 'group');
        assert.strictEqual((store.load('file:///b.vcd') as any).rows[0].kind, 'signal');
    });
}
```

Adjust the test runner to await functions returning `void | Promise<void>`.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test` from `veriflow-vscode`.

Expected: TypeScript reports that `WaveformLayoutStore` cannot be found.

- [ ] **Step 3: Implement the store and integrate the provider**

Define a minimal `MementoLike` interface and serialize updates so concurrent panels cannot overwrite another resource. In `WaveformEditorProvider`, construct the store from `this._context.workspaceState`; include `layout: store.load(document.uri.toString())` in the `vcd` message; handle `saveLayout` by awaiting `store.save(document.uri.toString(), message.layout)`.

- [ ] **Step 4: Inline `viewer-core.js` before `viewer.js` in the VS Code HTML**

Read both assets in `_getHtml` and emit:

```html
<script nonce="${nonce}">
${coreScript}
${script}
</script>
```

- [ ] **Step 5: Run and confirm GREEN**

Run: `npm test` from `veriflow-vscode`.

Expected: store tests, compilation, and all prior tests exit 0.

- [ ] **Step 6: Commit VS Code persistence**

```powershell
git add -- veriflow-vscode/src/core/waveformLayoutStore.ts veriflow-vscode/src/test/core.test.ts veriflow-vscode/src/waveformEditorProvider.ts
git commit -m "feat: persist VS Code waveform layouts"
```

### Task 5: Shared Assets and Toolbar Contract

**Files:**
- Modify: `tests/test_core_services.py`
- Modify: `src/presentation/gui/widgets/waveform_html.py`
- Modify: `veriflow-vscode/media/waveform/viewer.html`
- Modify: `veriflow-vscode/media/waveform/viewer.css`

- [ ] **Step 1: Write failing Python HTML contract tests**

Extend the existing shared HTML tests:

```python
assert "VeriflowWaveCore" in html
assert 'id="cursorA"' in html
assert 'id="cursorB"' in html
assert 'id="changeSearchMode"' in html
assert 'id="changeSearchValue"' in html
assert 'id="cursorMeasureText"' in html
```

- [ ] **Step 2: Run and confirm RED**

Run: `python -m pytest tests/test_core_services.py -q`.

Expected: `test_python_waveform_viewer_builds_shared_html` fails because the new core marker and controls are absent.

- [ ] **Step 3: Inline the core asset in Python**

Read `viewer-core.js` separately and place it before the transformed `viewer.js` in both `_build_waveform_html` and `_build_empty_waveform_html`.

- [ ] **Step 4: Add accessible shared controls and styles**

Add A/B buttons using `aria-pressed`, a five-option search selector, a disabled value input, and the combined measurement status element. Reuse `.icon-button` and toolbar theme variables; add compact `.cursor-toggle`, `.change-search`, and `.search-value` rules with a shrinking `.file-title` and no fixed toolbar overflow.

- [ ] **Step 5: Run and confirm GREEN**

Run: `python -m pytest tests/test_core_services.py -q`.

Expected: all tests in the file pass.

- [ ] **Step 6: Commit shared asset integration**

```powershell
git add -- tests/test_core_services.py src/presentation/gui/widgets/waveform_html.py veriflow-vscode/media/waveform/viewer.html veriflow-vscode/media/waveform/viewer.css
git commit -m "feat: add waveform cursor and search controls"
```

### Task 6: Viewer Layout Round Trip

**Files:**
- Create: `tests/fixtures/waveform_debug.vcd`
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Add a deterministic VCD fixture**

Create `tests/fixtures/waveform_debug.vcd` with timescale `10ns`, scalar `top.clk`, and four-bit `top.data`. Use changes at ticks 0, 5, 6, 10, 12, 15, 18, and 20, including rising/falling clock edges, vector values `1010` and `0011`, and value `10xz`. Make this repository fixture the first candidate returned by `_default_vcd()`.

- [ ] **Step 2: Add a failing smoke-hook layout check**

Call `window.__veriflowWaveViewer.captureLayout()`, clear the waveform list, call `restoreLayout(layout)`, and assert the waveform count, group count, colors, radix, name mode, expanded buses, view range, column widths, and cursor fields match the captured state.

- [ ] **Step 3: Run and confirm RED**

Run: `python tests/waveform_viewer_smoke.py tests/fixtures/waveform_debug.vcd`.

Expected: failure reports that `captureLayout` is undefined. If QtWebEngine is unavailable, record the dependency limitation without weakening the Node/Python tests.

- [ ] **Step 4: Implement serialization, restoration, and host save**

Add `fileName`, `layoutReady`, `lastSavedLayoutJson`, and a 250 ms save timer. Serialize group/signal descriptors, view dimensions, cursors, and active cursor. Restore only after VCD data is initialized, remap group IDs, match signal descriptors through `VeriflowWaveCore`, clamp view data, and render once. For VS Code, call both `vscode.setState({ layout })` and `vscode.postMessage({ type: 'saveLayout', layout })`; for Python, store JSON under `veriflow.waveform.layout.v1:<fileName>` in `localStorage`.

- [ ] **Step 5: Schedule persistence from stable UI state**

Call a JSON-change-deduplicated `scheduleLayoutSave()` after signal/group mutations, display-option changes, resizing completion, viewport changes, and cursor changes. Do not save during empty state setup or layout restoration.

- [ ] **Step 6: Re-run the layout check and regressions**

Run: `npm test` from `veriflow-vscode`, then `python -m pytest tests/test_core_services.py -q`.

Expected: both commands exit 0; browser smoke layout round-trip passes where QtWebEngine is available.

- [ ] **Step 7: Commit viewer layout integration**

```powershell
git add -- tests/fixtures/waveform_debug.vcd veriflow-vscode/media/waveform/viewer.js tests/waveform_viewer_smoke.py
git commit -m "feat: restore shared waveform layouts"
```

### Task 7: A/B Cursor UI Integration

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Add a failing A/B smoke-hook check**

Set A to tick 12 and B to tick 17 on a `10ns` fixture, select B, and assert state exposes `cursorA: 12`, `cursorB: 17`, `activeCursor: "b"`, `deltaText: "50 ns"`, and `frequencyText: "20 MHz"`.

- [ ] **Step 2: Run and confirm RED**

Expected: the state still exposes only `cursorTime`.

- [ ] **Step 3: Replace the single cursor state and rendering**

Use `cursorA`, nullable `cursorB`, and `activeCursor`. Add `activeCursorTime()` and `setActiveCursorTime(time)`. Draw labeled A/B lines in distinct theme colors, update `aria-pressed`, and fill the combined status with `VeriflowWaveCore.measureCursors`.

- [ ] **Step 4: Route navigation and input to the active cursor**

Update canvas clicks, Go To, start/end, page navigation, fit/time-range selection, change navigation, displayed signal values, and keyboard A/B handling. Preserve existing behavior with A active by default.

- [ ] **Step 5: Run and confirm GREEN**

Run: `npm test` from `veriflow-vscode`, then `python -m pytest tests/test_core_services.py -q`, then the QtWebEngine smoke command from Task 9.

Expected: unit suites exit 0 and the smoke state reports correct A/B measurement.

- [ ] **Step 6: Commit cursor integration**

```powershell
git add -- veriflow-vscode/media/waveform/viewer.js tests/waveform_viewer_smoke.py
git commit -m "feat: add dual waveform cursors"
```

### Task 8: Conditional Search UI Integration

**Files:**
- Modify: `veriflow-vscode/media/waveform/viewer.js`
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Add failing viewer search checks**

Through the test hook, add/select `top.clk` and `top.data`, then verify next rising edge, previous falling edge, exact `0xA`, X/Z, a selected expanded-bit edge, invalid input, and the no-wrap boundary. Assert successful searches move the active cursor and unsuccessful searches do not.

- [ ] **Step 2: Run and confirm RED**

Expected: the new search hook or conditional-search controller is absent.

- [ ] **Step 3: Implement target collection and bus-bit selection**

Track a nullable selected bus-bit descriptor separately from edit selection. Highlight it in both name list and canvas. Clear it when a base/group/multi selection replaces it. Build ordered search targets from the selected bit, selected base signals, or all added base signals.

- [ ] **Step 4: Integrate condition controls and search results**

Enable the value input only for Exact value. Call `VeriflowWaveCore.findSearchMatch`; translate errors into concise status messages; move the active cursor; center off-screen results at the existing zoom span; select the matched target; refresh values. Keep Arrow Left/Right and the existing buttons mapped to the selected search mode.

- [ ] **Step 5: Run and confirm GREEN**

Run: `npm test` from `veriflow-vscode`, then `python -m pytest tests/test_core_services.py -q`, then the QtWebEngine smoke command from Task 9.

Expected: all conditions pass, Any change retains previous behavior, and boundary searches leave the cursor unchanged.

- [ ] **Step 6: Commit search integration**

```powershell
git add -- veriflow-vscode/media/waveform/viewer.js tests/waveform_viewer_smoke.py
git commit -m "feat: search waveform transitions and values"
```

### Task 9: Browser Smoke Consolidation

**Files:**
- Modify: `tests/waveform_viewer_smoke.py`

- [ ] **Step 1: Consolidate browser-level assertions**

Ensure the smoke flow reports one failure at a time and verifies layout restoration, A/B measurement, every conditional-search mode, existing grouping, bus expansion, formatting, multiselect behavior, and final waveform pixels.

- [ ] **Step 2: Run the complete browser smoke test**

Run: `python tests/waveform_viewer_smoke.py tests/fixtures/waveform_debug.vcd`.

Expected: exit 0 and output reports layout restoration, dual-cursor measurement, conditional-search checks, grouping, bus bits, formatting, multiselect, and waveform rendering.

- [ ] **Step 3: Commit the final smoke flow**

```powershell
git add -- tests/waveform_viewer_smoke.py
git commit -m "test: cover waveform debug workflow"
```

### Task 10: Full Verification and Scope Audit

**Files:**
- Verify all modified files from Tasks 1 through 9.

- [ ] **Step 1: Run JavaScript/TypeScript verification**

Run: `npm test` from `veriflow-vscode`.

Expected: TypeScript compiles, every named test prints `ok`, and the process exits 0.

- [ ] **Step 2: Run Python verification**

Run: `python -m pytest` from the repository root.

Expected: all collected tests pass with only the existing desktop-smoke skip.

- [ ] **Step 3: Run browser verification**

Run: `python tests/waveform_viewer_smoke.py tests/fixtures/waveform_debug.vcd`.

Expected: exit 0 with all waveform feature checks reported.

- [ ] **Step 4: Run diff and worktree checks**

Run:

```powershell
git diff --check
git status --short
git diff --stat e9cd3e6..HEAD
```

Expected: no whitespace errors; only the user's pre-existing `.gitignore` modification and moved `vlib.py`/test/design deletions remain outside the feature commits.

- [ ] **Step 5: Compare implementation with the design acceptance criteria**

Confirm every acceptance item in `docs/superpowers/specs/2026-07-18-waveform-debug-productivity-design.md` has either an automated unit test, shared HTML contract test, or QtWebEngine smoke assertion. Add a missing failing test before correcting any discovered gap.

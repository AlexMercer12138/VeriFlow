# AD Editor Shared Schematic UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish the label-free, high-contrast schematic canvas, logical network selection, and shared read-only Inspector that the editable `.ad` custom editor will extend.

**Architecture:** Keep semantic network names in `@veriflow/schematic-core`, but stop producing canvas label geometry. Restrict X6 Selection to movable graph nodes and keep one logical selected network ID in webview state so segments and junctions can be highlighted without selection boxes. Derive Inspector rows from the immutable `SchematicGraph`; later `.ad` commands will reuse the shell while adding editable controls through the host protocol.

**Tech Stack:** TypeScript, Node test runner, AntV X6, Lucide, Electron, Playwright, VS Code webviews, esbuild.

---

## Scope Boundary

This plan is the shared UX foundation phase. It completes the four reported
schematic defects and the read-only Inspector required by both HDL inspection
and `.ad` authoring. After this plan is verified, the next implementation plan
starts the versioned `.ad` model, validation, RTL export, CLI commands, and
custom-editor write protocol described in:

- `docs/plans/2026-08-09-schematic-arch-design-design.md`
- `docs/plans/2026-08-11-ad-editor-schematic-ux-design.md`

No Python source or Python tests are introduced or run.

### Task 1: Remove Network Labels From Canvas Geometry

**Files:**
- Modify: `packages/schematic-core/test/layout.test.ts`
- Modify: `packages/schematic-core/test/adversarialLayout.test.ts`
- Modify: `packages/schematic-core/src/layout.ts`
- Modify: `packages/schematic-core/src/renderModel.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`

**Step 1: Write the failing core contract**

Replace label-placement assertions with semantic-name assertions and require
every route to omit label geometry:

```ts
test('keeps network names semantic without producing canvas labels', () => {
    const graph = complexGraph();
    graph.networks[0].adapterLabel = '[7:0]';

    const measured: string[] = [];
    const result = layoutSchematic(graph, undefined, text => {
        measured.push(text);
        return text.length * 2;
    });
    const route = result.networks[0];

    assert.equal(route.name, 'clk_distribution');
    assert.equal(route.displayName, 'clk_distribution [7:0]');
    assert.equal(route.selectionDescription, 'clk_distribution');
    assert.equal(route.label, undefined);
    assert.equal(measured.includes(route.displayName), false);
});
```

Update adversarial coverage to require `route.label === undefined` and remove
the obsolete label-collision test. Keep node text, routes, junctions, semantic
selection descriptions, and public bounds covered.

**Step 2: Run the core test and verify RED**

Run:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: FAIL because `layoutSchematic` still measures and places network
labels.

**Step 3: Remove label placement from the core**

Delete `RectangleIndex`, `rectanglesOverlap`, `measuredLabelWidth`, and
`labelForNetwork` from `packages/schematic-core/src/layout.ts`. Construct
routes with semantic names only:

```ts
return Object.freeze({
    id: network.id,
    name: network.name,
    displayName,
    selectionDescription: network.name,
    feedback: route.feedback,
    terminals,
    segments,
});
```

Remove the label list from `calculateBounds`; bounds must include only nodes,
segments, and junction dots. Retain the optional `NetworkRoute.label` type as
deprecated compatibility surface for this release, but never populate it:

```ts
export type NetworkRoute = Readonly<{
    // ...semantic and route fields...
    /** @deprecated Network names are shown in the Inspector, not on canvas. */
    label?: NetworkRouteLabel;
}>;
```

**Step 4: Write failing webview contracts**

In `schematicAssets.test.ts`, require the canonical segment loop to omit X6
`labels`, and require no `labelForSegment` helper. In the Electron visual test,
change the geometry assertion to:

```ts
assert.equal(geometry.labelCount, 0);
```

Remove the obsolete `placeSchematicNetworkLabel` tests and import from
`schematicWebviewSupport.test.ts`.

**Step 5: Run the webview tests and verify RED**

Run:

```bash
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicAssets.test.js
```

Expected: FAIL because the renderer still passes X6 label cells.

**Step 6: Remove browser label rendering**

Delete `labelForSegment`, network label style imports, and the `labels` option
from `packages/schematic-webview/src/index.ts`. Delete the unused browser-side
placement types and `placeSchematicNetworkLabel` helper from
`webviewSupport.ts`. Keep network names in search text, accessibility labels,
selection descriptions, and future Inspector data.

**Step 7: Run focused tests and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/schematic-core
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/schematicAssets.test.js
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/schematic-core packages/schematic-webview/src/index.ts \
  veriflow-vscode/src/schematic/webviewSupport.ts \
  veriflow-vscode/src/test/schematicWebviewSupport.test.ts \
  veriflow-vscode/src/test/schematicAssets.test.ts \
  packages/waveform-desktop/test/schematicWebview.test.ts
git commit -m "fix: keep network names off schematic canvas"
```

### Task 2: Make Port Names Explicit and Increase Canvas Contrast

**Files:**
- Modify: `packages/schematic-core/test/nodeGeometry.test.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/src/index.ts`

**Step 1: Add a boundary-port characterization test**

Extend the existing compact port test to lock the title contract:

```ts
assert.equal(measured.title.fullText, 'data');
assert.equal(measured.title.visibleText, 'data');
assert.equal(measured.title.truncated, false);
assert.ok(measured.title.clipBounds.width > measureWidth('data'));
```

This records that the semantic port name already reaches core geometry. If it
passes immediately, keep it as characterization coverage and continue with the
browser-level regression test, which owns the reported visibility defect.

**Step 2: Write failing browser contrast and port-name contracts**

Add source assertions that the stylesheet defines and the renderer consumes
these semantic tokens:

```text
--schematic-canvas
--schematic-node-fill
--schematic-node-border
--schematic-text
--schematic-muted-text
--schematic-pin
--schematic-wire
--schematic-wire-selected
--schematic-junction
```

In the Electron visual fixture, inspect both top-level port nodes and require:

```ts
assert.deepEqual(portTitles, ['input_a', 'input_b', 'result_out']);
assert.deepEqual(portTitleOverflow, []);
assert.ok(nodeBorderContrast >= 3);
assert.ok(textContrast >= 4.5);
assert.ok(wireContrast >= 3);
```

Inject a representative low-brightness VS Code variable set before sending the
graph so the test reproduces the weak `editorWidget-border` case.

**Step 3: Run focused browser tests and verify RED**

Run:

```bash
npm run build:web
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: FAIL because the renderer directly uses weak VS Code variables and
does not expose the semantic token contract.

**Step 4: Define high-contrast semantic tokens**

In `index.css`, define stable variables with high-contrast variables first and
light/dark-safe fallbacks. The node border must not fall back through the weak
widget border:

```css
:root {
    --schematic-canvas: var(--vscode-editor-background, #ffffff);
    --schematic-node-fill: var(--vscode-editorWidget-background, #f6f8fa);
    --schematic-node-border: var(--vscode-contrastBorder,
        var(--vscode-editor-foreground, #3f4a5a));
    --schematic-text: var(--vscode-editor-foreground, #1f2328);
    --schematic-muted-text: var(--vscode-descriptionForeground, #57606a);
    --schematic-pin: var(--vscode-contrastActiveBorder,
        var(--vscode-editor-foreground, #1f2328));
    --schematic-wire: var(--vscode-editor-foreground, #3f4a5a);
    --schematic-wire-selected: var(--vscode-focusBorder, #0969da);
    --schematic-junction: var(--schematic-wire);
}
```

Update all X6 body, pin, wire, junction, grid, and search-reset attributes to
consume these variables. Use a stronger node stroke and preserve the existing
multi-color kind accents. Do not change routing geometry.

**Step 5: Keep the port title on the explicit text path**

Keep `model.label` as the top-level port title and the compact title clip inside
the body. Do not substitute the connected network name and do not show the port
pin label as a second copy. Ensure the Electron assertion checks the visible
SVG text inside each `port:*` node.

**Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/schematic-core
npm run build:web
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: PASS with three visible top-level names and the required contrast
ratios at desktop and narrow viewports.

**Step 7: Commit**

```bash
git add packages/schematic-core/test/nodeGeometry.test.ts \
  packages/schematic-webview/src/index.css \
  packages/schematic-webview/src/index.ts \
  packages/waveform-desktop/test/schematicWebview.test.ts \
  veriflow-vscode/src/test/schematicAssets.test.ts web-dist/schematic
git commit -m "fix: strengthen schematic canvas visibility"
```

### Task 3: Select Networks Logically Without X6 Edge Boxes

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`

**Step 1: Write the failing source contract**

Replace expansion-based selection assertions with these requirements:

```ts
assert.match(selectionOptions, /showEdgeSelectionBox: false/);
assert.match(selectionOptions, /filter: cell => cellData\(cell\)\?\.objectType === 'node'/);
assert.match(source, /let selectedNetworkId: string \| undefined/);
assert.match(source, /graph\.on\('edge:click'/);
assert.doesNotMatch(source, /function expandNetworkSelection/);
```

Require junction nodes to carry the same logical network ID and accept clicks
without becoming X6 Selection nodes.

**Step 2: Write the failing Electron interaction**

After clicking one fanout segment, require:

```ts
assert.equal(await page.locator(
    '.x6-widget-selection-box[data-cell-id^="network:visual-fanout:"]'
).count(), 0);
assert.equal(await page.locator('#selection-status').textContent(), 'network: fanout');
assert.equal(selectedSegmentCount, fanoutSegmentCount);
assert.ok(selectedJunctionCount > 0);
assert.equal(lastSavedLayout.selectedObjectId, 'network:visual-fanout');
```

Then click a module and require the network highlight to clear while node
selection boxes still work. Rubber-band selection and batch movement must keep
their existing assertions.

**Step 3: Run the interaction test and verify RED**

Run:

```bash
npm run build:web
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry|selection boxes" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: FAIL because every network segment is currently inserted into X6
Selection and receives a selection box.

**Step 4: Introduce logical network selection state**

Configure X6 Selection for nodes only:

```ts
const selection = new Selection({
    enabled: true,
    multiple: true,
    rubberband: true,
    movable: true,
    showNodeSelectionBox: true,
    showEdgeSelectionBox: false,
    filter: cell => cellData(cell)?.objectType === 'node'
        && cellData(cell)?.junction !== true,
});

let selectedNetworkId: string | undefined;
```

Add one selection transition function that:

- clears X6 node selection before selecting a network;
- clears the logical network before selecting nodes;
- persists only the semantic object ID in `currentLayout.selectedObjectId`;
- refreshes every segment and junction whose `CellData.objectId` matches;
- updates status and search state once per logical object.

Handle `edge:click`, junction `node:click`, and `blank:click`. Restore a saved
network directly into `selectedNetworkId`; never select all of its X6 cells.
Search must select a matching network through the same transition function.

**Step 5: Make junctions clickable but non-movable**

Give junction roots a network accessibility label and pointer events, while
keeping `interacting: false` and excluding them from X6 Selection. Use the same
semantic selected wire token for their fill and stroke. Ordinary bends remain
absent because junction generation is unchanged.

**Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicAssets.test.js
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry|selection boxes" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: PASS. Network clicks highlight only electrical geometry; node single
and rubber-band selections still show and move selection boxes.

**Step 7: Commit**

```bash
git add packages/schematic-webview/src/index.ts \
  packages/schematic-webview/src/index.css \
  veriflow-vscode/src/test/schematicAssets.test.ts \
  packages/waveform-desktop/test/schematicWebview.test.ts web-dist/schematic
git commit -m "fix: select schematic networks without edge boxes"
```

### Task 4: Add the Shared Read-Only Inspector

**Files:**
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`
- Modify: `packages/schematic-webview/src/index.html`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`

**Step 1: Write failing Inspector projection tests**

Define a host-neutral presentation model in `webviewSupport.ts`:

```ts
export type SchematicInspectorModel = Readonly<{
    kind: 'empty' | 'network' | 'instance' | 'port' | 'node' | 'multiple';
    title: string;
    readOnly: true;
    rows: readonly Readonly<{ label: string; value: string }>[];
}>;
```

Test projections for:

- network name, adapter label, width, drivers, loads, and bidirectional ends;
- instance name, module type, pins, definition availability, and read-only mode;
- top-level name, HDL direction, width, and connected network;
- two selected nodes as a multiple-selection summary;
- stale IDs as the empty model.

Run:

```bash
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
```

Expected: FAIL because no Inspector projection exists.

**Step 2: Implement the minimal projection**

Add `projectSchematicInspector(graph, selectedNodeIds, selectedNetworkId)` and
small deterministic width/direction/endpoint formatters. Read graph data only;
do not add host calls or mutation APIs.

**Step 3: Write failing shell and interaction tests**

Require this structure:

```html
<div id="content-row">
    <section id="canvas-region">...</section>
    <aside id="inspector" aria-label="Properties">...</aside>
</div>
```

Add an icon button with `aria-controls="inspector"` and default expanded state.
Electron must verify the Inspector is about 280px wide, contains the selected
network name after a segment click, contains instance/module fields after a
node click, and collapses without overlapping the canvas at 440px width.

**Step 4: Add the shell and renderer**

Use a `36px / minmax(0, 1fr) / 24px` outer grid, with `#content-row` holding a
flexible canvas and fixed responsive Inspector. Render rows as a semantic `dl`.
Use Lucide `PanelRightClose`/`PanelRightOpen` in the toggle button. Keep the
status strip as the compact summary; do not write files from the webview.

Every selection transition and graph refresh must call one
`renderInspector(projectSchematicInspector(...))` path. Stale selected IDs are
cleared by the same restore logic used for highlighting.

**Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/schematicAssets.test.js
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: PASS at desktop and narrow viewports.

**Step 6: Commit**

```bash
git add veriflow-vscode/src/schematic/webviewSupport.ts \
  veriflow-vscode/src/test/schematicWebviewSupport.test.ts \
  veriflow-vscode/src/test/schematicAssets.test.ts \
  packages/schematic-webview/src \
  packages/waveform-desktop/test/schematicWebview.test.ts web-dist/schematic
git commit -m "feat: add shared schematic inspector"
```

### Task 5: Complete Integrated Visual and Packaging Verification

**Files:**
- Modify if generated: `web-dist/schematic/index.css`
- Modify if generated: `web-dist/schematic/index.html`
- Modify if generated: `web-dist/schematic/index.js`
- Create ignored artifacts: `.artifacts/ad-editor/desktop.png`
- Create ignored artifacts: `.artifacts/ad-editor/narrow.png`

**Step 1: Build canonical web assets**

Run:

```bash
npm run build:web
npm run verify:generated
```

Expected: PASS and canonical `web-dist/schematic` matches source.

**Step 2: Run the complete Node/TypeScript suite**

Run:

```bash
xvfb-run -a npm test
```

Expected: PASS, including 191+ schematic-core tests, Electron schematic tests,
all VS Code tests, and VSIX packaging. Do not run Python tests.

**Step 3: Inspect visual artifacts**

Run the Electron visual test with:

```bash
VERIFLOW_SCHEMATIC_SCREENSHOT_DIR=.artifacts/ad-editor \
xvfb-run -a node --test --test-name-pattern="obstacle-free geometry" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Inspect both screenshots and confirm:

- every top-level node contains its port name;
- no network text or label background appears;
- selected network has only highlighted segments and junctions;
- no wire selection rectangle appears;
- module, port, pin, wire, and Inspector boundaries remain visible;
- canvas and Inspector do not overlap at 440px.

**Step 4: Package the VSIX**

Run the repository's existing VSIX packaging test through `npm test`, then
inspect `git status --short` to ensure no untracked release output or unrelated
changes remain.

**Step 5: Commit any final generated asset refresh**

```bash
git add web-dist/schematic
git commit -m "build: refresh schematic web assets"
```

Skip the commit when the generated assets were already committed in Tasks 1-4
and the worktree is clean.

## Follow-Up Phase

After this plan passes, create
`docs/plans/2026-08-11-arch-design-core-implementation.md` and execute the next
dependency-ordered phase:

1. versioned `.ad` schema, parser, serializer, and migration boundary;
2. validation, top-level input/output/inout graph projection, and defaults;
3. deterministic Verilog-2001 exporter with optional SystemVerilog output;
4. `veriflow ad validate` and `veriflow ad export`;
5. `.ad` custom editor document lifecycle and typed edit commands;
6. protocol recognition, collapsed interfaces, and transparent default rules.

Each phase must reuse `@veriflow/schematic-core`, remain Node/TypeScript-only,
and preserve `.v/.sv` as read-only schematic inputs.

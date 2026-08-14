# AD Short Routing And Boundary Port Shapes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prefer safe short cross-column routes and render discoverable directional boundary ports without changing the existing placement architecture.

**Architecture:** Extend the transactional router with one additional vertical-trunk candidate that is validated and scored by the existing preflight machinery before corridor fallbacks. Add boundary body classification to the shared render model, make multi-pin boundary geometry allocate distinct rows, and let the X6 webview select a normalized SVG path from that render metadata.

**Tech Stack:** TypeScript, Node test runner, `@antv/x6`, esbuild, Playwright/Electron.

---

### Task 1: Safe Cross-Column Short Routes

**Files:**
- Modify: `packages/schematic-core/test/router.test.ts`
- Modify: `packages/schematic-core/src/routing/router.ts`

**Step 1: Write the failing test**

Add a routing fixture with a source in column 0, a vertically offset middle
module in column 1, and a vertically offset sink in column 2. Assert that the
clear route has exactly `horizontal`, `vertical`, `horizontal` segments, does
not allocate a horizontal corridor, and avoids every module body. Keep the
existing three-column blocked fixture expecting `H-V-H-V-H` as the fallback
characterization.

**Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/router.test.js
```

Expected: the new test fails because the route contains five segments and a
horizontal corridor.

**Step 3: Implement the minimal short-path plan**

Add a planned path kind for an ordinary vertical shortcut. Generate candidates
only for non-feedback endpoints in different columns. Try a direct segment for
aligned endpoints, otherwise allocate or reuse a vertical track in each channel
between the endpoint columns and materialize `H-V-H`. Feed every candidate
through the existing transaction, obstacle validation, reservation validation,
and realized added-length comparison. Leave current corridor and outer feedback
planning as fallback behavior.

**Step 4: Run focused and package tests and verify GREEN**

Run the focused command above, then:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: all schematic-core tests pass, with only the existing optional
`iverilog` skip.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/routing/router.ts packages/schematic-core/test/router.test.ts
git commit -m "feat(schematic): prefer safe short cross-column routes"
```

### Task 2: Boundary Body Classification And Multi-Pin Geometry

**Files:**
- Modify: `packages/schematic-core/test/nodeGeometry.test.ts`
- Modify: `packages/schematic-core/test/layout.test.ts`
- Modify: `packages/schematic-core/src/nodeGeometry.ts`
- Modify: `packages/schematic-core/src/renderModel.ts`
- Modify: `packages/schematic-core/src/layout.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write failing geometry and classification tests**

Add a three-pin boundary node test that asserts two left pins and one right pin
have distinct, centered row anchors and that its height grows beyond the compact
single-pin height. Add render-model assertions that scalar input/output ports
are `directional-port`, scalar inout ports are `bidirectional-port`, top-level
Master/Slave interface ports are `directional-port`, and ordinary instances
remain `rectangle`.

**Step 2: Run tests and verify RED**

Run the focused schematic-core command from Task 1.

Expected: compilation or assertions fail because boundary body metadata does
not exist and all port pins still share the center anchor.

**Step 3: Implement minimal shared geometry**

Add a frozen boundary body-shape union to `RenderedNodeGeometry`. Classify port
nodes from top-level interface metadata first, then scalar bidirectional or
multi-pin semantics. Keep unknown interfaces rectangular. Calculate boundary
height from the larger side-pin count and center each side's rows independently;
retain the current fixed dimensions and centered anchor for one-pin ports.

**Step 4: Run schematic-core tests and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: all schematic-core tests pass with the existing optional skip.

**Step 5: Commit**

```bash
git add packages/schematic-core/src packages/schematic-core/test
git commit -m "feat(schematic): model directional boundary port geometry"
```

### Task 3: Render Arrow And Bidirectional Port Bodies

**Files:**
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Regenerate: `web-dist/schematic/index.js`

**Step 1: Write the failing runtime test**

Extend the canonical visual fixture with an unconnected three-pin inout port.
Assert the scalar input/output bodies carry a directional path class, the inout
body carries a bidirectional path class, all three inout pin centers are
distinct, and a top-level interface port also carries the directional class.

**Step 2: Build current assets and verify RED**

Run:

```bash
npm run build:web
npx tsc -p packages/waveform-desktop/tsconfig.test.json
node --test --test-name-pattern="schematic runtime paints|Arch Design interfaces render" packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: the new assertions fail because port bodies are still rectangles and
do not expose directional classes.

**Step 3: Implement X6 body paths**

Register port nodes with a transparent rectangular hit area and a scalable SVG
path body. Use a right-pointing pentagon for `directional-port`, a symmetric
double-ended hexagon for `bidirectional-port`, and a rectangular path for the
unknown fallback. Preserve the current green or purple accent, labels,
selection behavior, and rectangular layout bounds.

**Step 4: Build and run runtime verification**

Run the command from Step 2 again, followed by:

```bash
npm run typecheck --workspace @veriflow/schematic-webview
npm test --workspace @veriflow/waveform-desktop
```

Expected: all Electron tests pass and screenshots contain nonblank canvas
pixels at desktop and narrow viewports.

**Step 5: Commit**

```bash
git add packages/schematic-webview/src/index.ts packages/waveform-desktop/test/schematicWebview.test.ts web-dist/schematic/index.js
git commit -m "feat(schematic): render directional boundary port shapes"
```

### Task 4: Correct Shared-Channel Routing And Inout Semantics

**Files:**
- Modify: `packages/schematic-core/test/router.test.ts`
- Modify: `packages/schematic-core/test/pins.test.ts`
- Modify: `packages/schematic-core/test/layout.test.ts`
- Modify: `packages/schematic-core/src/routing/router.ts`
- Modify: `packages/schematic-core/src/pins.ts`
- Modify: `packages/schematic-core/src/layout.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Regenerate: `web-dist/schematic/index.js`

**Step 1: Write failing routing tests**

Add two ordered, non-crossing networks between different pins on the same pair
of adjacent-column modules. Assert that both paths are `H-V-H`. Preserve the
existing crossed-pin fixture and its separate-corridor behavior.

**Step 2: Run the focused router test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test --test-name-pattern="shared adjacent module pins" packages/schematic-core/dist-test/test/router.test.js
```

Expected: FAIL because module-row equality marks the ordered routes as a
conflict and forces five-segment corridor paths.

**Step 3: Correct the conflict predicate and verify GREEN**

Store the realized left and right pin Y coordinates in each adjacent
descriptor. Sort and compare those coordinates, treating equal geometry as a
conflict only when two descriptors actually compete for the same pin position.
Run the focused test plus the complete schematic-core suite.

**Step 4: Write failing inout geometry and runtime tests**

Assert that the top-level inout `o` and `t` anchors are left, `i` is right, and
its body shape is `directional-port`. In the Electron fixture, assert the `t`
marker has an amber double-ring class, all `i/o/t` markers expose their native
hover descriptions, and ordinary instance pins do not receive those classes.

**Step 5: Run the focused tests and verify RED**

Run:

```bash
npm test --workspace @veriflow/schematic-core
npm run build:web
npx tsc -p packages/waveform-desktop/tsconfig.test.json
node --test --test-name-pattern="schematic runtime paints" packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: core assertions fail because all boundary pins inherit the first
pin's side and the inout remains bidirectional; runtime assertions fail because
the markers have no semantic class or hover description.

**Step 6: Implement the inout behavior and verify GREEN**

Resolve each multi-pin boundary by its individual direction (`load` left,
`driver` right), classify the inout body as directional, and attach semantic
marker classes and native `title` attributes only for three-pin top-level
inout nodes. Render `t` with an amber outer ring while retaining the normal
inner pin marker and existing selection behavior. Rebuild the web assets and
run the focused suites.

**Step 7: Commit**

```bash
git add packages/schematic-core packages/schematic-webview packages/waveform-desktop/test web-dist/schematic/index.js
git commit -m "fix(schematic): clarify adjacent routes and inout pins"
```

### Task 5: Full Regression And Visual Verification

**Files:**
- Verify: all changed files and generated web assets

**Step 1: Check formatting and generated assets**

Run:

```bash
git diff --check
npm run verify:generated
```

Expected: both commands exit successfully.

**Step 2: Run the complete Node suite**

Run:

```bash
npm test
```

Expected: every Node suite passes; the optional Icarus test may remain skipped
when `iverilog` is unavailable. Do not run Python tests.

**Step 3: Verify the actual AD demo with captured evidence**

Open `/tmp/veriflow-ad-editor-demo/stream_pipeline.ad` in the Extension
Development Host, fit the diagram, and capture a screenshot. Extract the
rendered segment orientations for `sample_in`, `sample_valid`,
`s_axi_control`, `result_out`, and `result_valid`; assert clear unaligned
connections use exactly `horizontal-vertical-horizontal`, and inspect the
screenshot for module intersections or overlapping wire segments.

**Step 4: Review the final diff and commit any verification-only adjustments**

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

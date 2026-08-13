# AD Pin Selection And Demo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make each schematic pin selectable from either its circle or its full label, highlight both targets together, and expand the manual AD demo with multi-column and AXI interface scenarios.

**Architecture:** Keep X6 magnets and connection authoring on the existing pin circles. Add a label-only selection path that resolves the owning node and pin ID, then reuse the current pin selection state and Inspector update flow. Style the selected port group so both the circle and label are emphasized. Keep the demo outside the repository in `/tmp/veriflow-ad-editor-demo` and use the built-in AXI4 recognizer through real HDL declarations.

**Tech Stack:** TypeScript, AntV X6, CSS, Playwright Electron tests, VeriFlow Arch Design JSON.

---

### Task 1: Expand Pin Selection Hit Area

**Files:**
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify generated: `web-dist/schematic/index.js`
- Modify generated: `web-dist/schematic/index.css`

**Step 1: Write a failing Electron test**

Click a pin label rather than its circle, then require the pin Inspector, selected circle class, and selected label class. Also assert that label clicking does not start connection authoring.

**Step 2: Run the focused test and verify RED**

Run:

```bash
npm run vscode:prepublish --prefix veriflow-vscode
xvfb-run -a npm test --prefix packages/waveform-desktop -- --test-name-pattern="interface pins drive Inspector"
```

Expected: FAIL because the label does not select the pin and cannot receive selected styling.

**Step 3: Implement the minimal selection path**

Give the label container a stable selectable marker and pointer events, delegate label clicks from the canvas, resolve the node and pin ID, and call one shared pin-selection helper used by circle clicks. Keep `magnet` only on `portBody`.

**Step 4: Highlight circle and label together**

Apply the existing selected class to the whole matching port group and add selected label fill/font-weight rules without changing interface role colors when unselected.

**Step 5: Verify focused and related tests**

Run the focused Electron test, asset contract test, full Electron suite, generated asset verification, and `git diff --check`.

### Task 2: Expand The Manual AD Demo

**Files:**
- Modify external fixture: `/tmp/veriflow-ad-editor-demo/stream_blocks.sv`
- Modify external fixture: `/tmp/veriflow-ad-editor-demo/stream_pipeline.ad`
- Create external fixture: `/tmp/veriflow-ad-editor-demo/project.json`

**Step 1: Add real HDL modules**

Add a multi-stage scalar processing path plus AXI4 master, interconnect, and slave modules whose port declarations are recognized by the built-in catalog.

**Step 2: Add independent visual scenarios**

Keep the current stream pipeline, add a longer multi-column connection path, one internal AXI interface connection, and top-level promoted AXI Master and Slave interfaces.

**Step 3: Validate the fixture**

Run:

```bash
node packages/cli/dist/main.js ad validate \
  /tmp/veriflow-ad-editor-demo/stream_pipeline.ad \
  --project /tmp/veriflow-ad-editor-demo/project.json
```

Expected: validation succeeds, with no errors. Width warnings are acceptable only when deliberately demonstrated.

**Step 4: Launch the Extension Development Host**

Build the extension and open the demo `.ad` file in a fresh VS Code Extension Development Host.

### Task 3: Verify And Commit

**Step 1: Run full verification**

Run `xvfb-run -a npm test`, `npm run verify:generated`, and `git diff --check`.

**Step 2: Inspect repository status**

Confirm only the planned source, test, generated assets, and this plan are changed. The `/tmp` demo remains untracked by design.

**Step 3: Commit repository changes**

Commit the pin selection behavior and its tests. Do not commit `/tmp` demo files.

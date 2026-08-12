# AD Editor Interaction Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove full graph reloads from Arch Design selection and presentation changes while centering a design once on first open.

**Architecture:** Selection remains local webview state. Viewport and placement still use `.ad` presentation, but the provider recognizes its own presentation-only document replacement and responds with a lightweight revision acknowledgement instead of republishing the graph. A graph flag requests an automatic fit only once per module in the current webview.

**Tech Stack:** TypeScript, VS Code Custom Text Editor API, AntV X6, Node test runner, Playwright Electron.

---

### Task 1: Provider-Owned Presentation Changes

**Files:**
- Modify: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`
- Modify: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`

**Step 1: Write the failing tests**

Extend the provider harness so `workspace.applyEdit` can update the fake text
document and fire `onDidChangeTextDocument`. Assert that a `saveLayout` command
produces one text replacement and one `archDesignLayoutSaved` event, without a
second `initialize`, `graph`, or `archDesignState` event.

Add a second assertion that a later semantic edit starts from the design whose
presentation was just saved. Add an external-change case that does not match
the pending replacement and still performs a full refresh.

**Step 2: Run the tests and verify RED**

Run: `npm test --prefix veriflow-vscode -- --test-name-pattern="presentation"`

Expected: FAIL because `archDesignLayoutSaved` does not exist and document
changes currently republish the full graph.

**Step 3: Implement the minimal provider path**

Add a typed host event:

```ts
| { type: 'archDesignLayoutSaved'; revision: string }
```

Track the expected serialized text, resulting design, and source snapshot for
one provider-owned presentation edit. When the matching document event arrives,
create a new snapshot with an advanced revision and the new design, then post
only the acknowledgement. Mismatched events clear the pending write and call
the existing full refresh. A failed apply clears the matching pending entry.

**Step 4: Run the tests and verify GREEN**

Run: `npm test --prefix veriflow-vscode -- --test-name-pattern="presentation"`

Expected: PASS.

### Task 2: Local Arch Design Selection

**Files:**
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `packages/schematic-webview/src/index.ts`

**Step 1: Write the failing Electron test**

Publish an editable Arch Design fixture, click an instance and a network, wait
past the layout debounce, and assert that the selection and Inspector remain
active while no `saveLayout` command was posted solely for either selection.

**Step 2: Run the test and verify RED**

Run: `npm run vscode:prepublish --prefix veriflow-vscode && xvfb-run -a npm test --prefix packages/waveform-desktop -- --test-name-pattern="Arch Design selection stays local"`

Expected: FAIL because selection currently schedules a layout save.

**Step 3: Implement local state persistence**

Split webview-state persistence from host layout posting. In Arch Design mode,
selection updates `currentLayout` and `vscode.setState` but does not invoke the
layout scheduler. Preserve that selected object across a genuine full graph
refresh when the object still exists. Keep read-only HDL selection behavior
unchanged.

**Step 4: Run the test and verify GREEN**

Run the focused Electron command again. Expected: PASS.

### Task 3: Lightweight Layout Acknowledgement

**Files:**
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `packages/schematic-webview/src/index.ts`

**Step 1: Write the failing Electron test**

Select an AD instance, attach a marker to its live SVG node, pan or drag and
capture the emitted layout save, then publish `archDesignLayoutSaved`. Assert
that the same marked element remains, the selection and Inspector survive, and
the next save/edit uses the acknowledged revision.

**Step 2: Run the test and verify RED**

Run the focused Electron test. Expected: FAIL because the host event is not
handled.

**Step 3: Implement acknowledgement handling**

Accept the event in the webview message boundary. Update `currentRevision` and
the editable Arch Design state's revision without invoking `renderSchematic`,
changing graph cells, or clearing selection.

**Step 4: Run the test and verify GREEN**

Run the focused Electron test. Expected: PASS.

### Task 4: First-Open Fit

**Files:**
- Modify: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `packages/schematic-webview/src/index.ts`

**Step 1: Write the failing tests**

Assert that the provider sets `fitOnFirstRender: true` only when
`design.presentation.viewport` is absent. In Electron, assert that such a graph
is centered without posting `saveLayout`; an explicit viewport is respected.
Publish a later flagged graph for the same module and assert it is not fitted a
second time.

**Step 2: Run the tests and verify RED**

Run the focused provider and Electron tests. Expected: FAIL because graph
events do not carry or apply a fit request.

**Step 3: Implement one-time fit**

Add optional `fitOnFirstRender` to graph events. Maintain a webview-local set of
modules already auto-fitted. During the first requested render, call
`zoomToFit({ padding: 24, maxScale: 1 })` while layout events are suppressed,
then copy the resulting viewport into the in-memory layout without scheduling
a save.

**Step 4: Run the tests and verify GREEN**

Run the focused provider and Electron tests. Expected: PASS.

### Task 5: Generated Assets And Regression Verification

**Files:**
- Generated: `veriflow-vscode/media/schematic/index.js`
- Generated: other checked-in schematic assets only if the existing build changes them

**Step 1: Build the webview**

Run: `npm run vscode:prepublish --prefix veriflow-vscode`

Expected: TypeScript and bundled schematic assets build successfully.

**Step 2: Run focused and full related tests**

Run the provider suite, protocol suite, schematic Electron suite, generated
asset verification, and `xvfb-run -a npm test`.

Expected: all tests pass with no unexpected warnings.

**Step 3: Inspect the diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only planned source, test, documentation,
and generated asset changes.

### Task 6: Manual Extension Host Verification

**Files:**
- Use: `/tmp/veriflow-ad-editor-demo/stream_pipeline.ad`

**Step 1: Start the Extension Development Host**

Launch the repository extension in VS Code and open the existing demo `.ad`
document with the Arch Design editor.

**Step 2: Verify interaction**

Select nodes and networks, pan the canvas, move one instance, and confirm that
selection remains visible, no loading overlay flashes, routing updates locally,
and the design opens centered on a fresh webview.

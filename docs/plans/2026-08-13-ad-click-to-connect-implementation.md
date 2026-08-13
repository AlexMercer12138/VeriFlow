# AD Click-to-Connect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Author AD scalar and interface connections with two endpoint clicks in either order while allowing right-button panning between clicks.

**Architecture:** Keep a Webview-local pending terminal and dashed preview edge. Normalize the two clicked terminals to semantic source/target or Master/Slave before sending the existing edit messages; clear pending state on explicit cancellation and graph lifecycle changes.

**Tech Stack:** TypeScript, AntV X6, Electron, Playwright, Node test runner.

---

### Task 1: Specify click-to-connect behavior

**Files:**
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`

**Steps:**

1. Replace drag-based authoring assertions with two endpoint clicks.
2. Add reverse-order scalar and interface cases.
3. Add right-button panning, incompatible endpoint, Escape, mode-toggle, and refresh lifecycle assertions.
4. Build and run the focused Electron test, confirming it fails because clicks do not yet create edits.

### Task 2: Implement pending connection state

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Regenerate: `web-dist/schematic/index.js`
- Regenerate: `web-dist/schematic/index.css`

**Steps:**

1. Add pending terminal identity, preview edge, and visual state helpers.
2. Disable drag-based X6 connection creation.
3. Handle port-circle clicks by starting, completing, or retaining a pending connection.
4. Normalize endpoint order before sending existing scalar or interface edits.
5. Cancel pending state on Escape, mode disable, authoring disable, and graph refresh.
6. Build generated assets and run the focused Electron test until it passes.

### Task 3: Verify and commit

**Files:**
- Verify all modified and generated files.

**Steps:**

1. Run `xvfb-run -a npm test`.
2. Run `npm run verify:generated` and `git diff --check`.
3. Inspect the final diff for stale drag behavior and generated-only noise.
4. Commit the feature with a scoped message.

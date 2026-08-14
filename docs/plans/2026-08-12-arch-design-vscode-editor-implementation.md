# Arch Design VS Code Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a writable `.ad` custom editor to the VS Code extension using the shared Arch Design core and existing schematic webview.

**Architecture:** Keep the HDL schematic provider unchanged and register a separate `ArchDesignEditorProvider`. Put deterministic document mutation in `@veriflow/schematic-core/arch-design`; the provider converts validated webview commands into native VS Code text edits, while the shared webview renders both read-only HDL and writable AD modes.

**Tech Stack:** TypeScript, VS Code custom text editors, `@veriflow/schematic-core`, X6, Lucide, Node test runner, Electron/Playwright, esbuild.

---

## Scope Boundary

This plan delivers schema-v1 scalar authoring: document lifecycle, instances,
top-level ports, scalar networks, parameter overrides, explicit defaults,
presentation persistence, diagnostics, and RTL export. Interface recognition,
collapsed buses, interface connections, and project-defined protocols remain a
follow-up phase.

### Task 1: Add The Host-Neutral Arch Design Edit Reducer

**Files:**
- Create: `packages/schematic-core/src/archDesign/edit.ts`
- Create: `packages/schematic-core/test/archDesignEdit.test.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`

**Step 1: Write failing reducer tests**

Cover one behavior per test:

```ts
test('adds an instance without mutating the source design', () => {
    const source = createEmptyArchDesign('soc');
    const next = applyArchDesignEdit(source, {
        type: 'addInstance',
        instance: { name: 'u_core', module: 'core' },
    });
    assert.deepEqual(source.instances, []);
    assert.deepEqual(next.instances, [{ name: 'u_core', module: 'core' }]);
    assert.ok(Object.isFrozen(next));
});
```

Add tests for instance rename/remove and endpoint/default/presentation cascade;
parameter set/clear; port add/update/remove; scalar connect/merge/disconnect;
connection rename/remove; design/connection default set/clear; export settings;
presentation replacement; duplicate/unknown targets; hostile dictionary keys;
and detached frozen output.

**Step 2: Run the test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignEdit.test.js
```

Expected: compilation fails because `applyArchDesignEdit` and
`ArchDesignEdit` do not exist.

**Step 3: Implement the minimal reducer API**

Define a discriminated edit union for:

```ts
type ArchDesignEdit =
    | { type: 'addInstance'; instance: ArchDesignInstance }
    | { type: 'renameInstance'; name: string; nextName: string }
    | { type: 'removeInstance'; name: string }
    | { type: 'setInstanceParameter'; instance: string; parameter: string;
        value?: ArchDesignParameterValue }
    | { type: 'addPort'; port: ArchDesignPort }
    | { type: 'updatePort'; name: string; port: ArchDesignPort }
    | { type: 'removePort'; name: string }
    | { type: 'connect'; source: ArchDesignEndpoint; target: ArchDesignEndpoint }
    | { type: 'disconnect'; endpoint: ArchDesignEndpoint; connection: string }
    | { type: 'renameConnection'; name: string; nextName: string }
    | { type: 'removeConnection'; name: string }
    | { type: 'setDefault'; endpoint: string; expression?: string;
        connection?: string }
    | { type: 'setExport'; language?: ArchDesignLanguage; output?: string }
    | { type: 'setPresentation'; presentation: ArchDesignPresentation };
```

Construct plain mutable copies, apply one edit, then pass the result through
`parseArchDesignValue`. Throw `ArchDesignEditError` for invalid commands or
unknown/duplicate targets. Never mutate or return caller-owned objects.

**Step 4: Verify GREEN and the package regression suite**

Run the three focused commands above, then:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: focused tests pass; package remains 0 failures with only the existing
optional Icarus skip when `iverilog` is unavailable.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesignEdit.test.ts
git commit -m "feat(schematic-core): edit Arch Design documents"
```

### Task 2: Add A Strict AD Webview Protocol And Projection Helpers

**Files:**
- Create: `veriflow-vscode/src/archDesign/editorSupport.ts`
- Create: `veriflow-vscode/src/test/archDesignEditorSupport.test.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`

**Step 1: Write failing protocol and projection tests**

Assert that `parseWebviewCommand` accepts normalized `editArchDesign` and
`exportArchDesign` commands, strips unknown properties, bounds strings and
collection sizes, accepts only schema-v1 edit variants, preserves own
`__proto__` keys, and returns `undefined` for malformed or getter-throwing
payloads.

Test pure helpers that:

- map `HdlDefinitionSummary[]` to detached module catalog entries;
- convert an AD presentation to `SchematicLayout`;
- convert a saved layout back to stable port/instance presentation only;
- derive an `ArchDesignEndpoint` from a graph node/pin;
- build an authoring snapshot without mutating the design or catalog.

**Step 2: Run and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicProtocol.test.js
node veriflow-vscode/out/test/archDesignEditorSupport.test.js
```

Expected: new commands and support module are missing.

**Step 3: Implement strict normalization and helpers**

Extend `WebviewCommand` with revision-bound edit/export commands. Extend
`HostEvent` with optional authoring mode on initialize and an
`archDesignState` event containing editable/read-only state, the design,
module catalog, validation diagnostics/defaults, and revision.

Keep every existing HDL message byte-compatible. All command normalization
must read own properties defensively and return detached values.

**Step 4: Verify GREEN**

Run the focused commands and `npm run typecheck --workspace
@veriflow/schematic-webview`.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/archDesign veriflow-vscode/src/schematic/protocol.ts \
  veriflow-vscode/src/schematic/webviewSupport.ts veriflow-vscode/src/test
git commit -m "feat(vscode): define Arch Design editor protocol"
```

### Task 3: Implement The AD Custom Text Editor Lifecycle

**Files:**
- Create: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`
- Create: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`

**Step 1: Write a provider harness and failing lifecycle tests**

Use a fake `TextDocument`, `WebviewPanel`, workspace index, diagnostic
collection, and `workspace.applyEdit`. Test:

- editable schema-v1 text publishes initialize, graph, authoring state, and
  diagnostic counts;
- catalog definitions bind instance pins and refresh on index invalidation;
- unknown schemas publish read-only authoring state and never rewrite text;
- invalid initial JSON publishes diagnostics without throwing;
- invalid external text retains the last valid graph;
- stale edit revisions are ignored;
- accepted edits create exactly one full-document `WorkspaceEdit`;
- document changes, panel disposal, cancellation, and index release are race
  safe.

**Step 2: Run and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
```

Expected: provider module is missing.

**Step 3: Implement the provider**

Parse with `parseArchDesignText`, fetch module definitions through injected
index services, project with `projectArchDesignGraph` and
`projectArchDesignPlacement`, and publish revisioned snapshots. Apply reducer
results through `serializeArchDesign` and a full-document `WorkspaceEdit`.

Use generation tokens around async index and post operations. Publish AD
diagnostics through a dedicated collection. Reuse `buildSchematicWebviewHtml`;
do not copy the HTML shell or generated assets.

**Step 4: Verify GREEN and existing provider regressions**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
node veriflow-vscode/out/test/schematicEditorProvider.test.js
```

**Step 5: Commit**

```bash
git add veriflow-vscode/src/archDesign veriflow-vscode/src/test/archDesignEditorProvider.test.ts
git commit -m "feat(vscode): host Arch Design documents"
```

### Task 4: Register `.ad` And Persist Layout Through The Document

**Files:**
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/test/schematicManifest.test.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`

**Step 1: Write failing manifest and layout tests**

Require:

- `veriflow.archDesignEditor` with `*.ad`, priority `default`;
- `onCustomEditor:veriflow.archDesignEditor` activation;
- an `arch-design` language association for `.ad`;
- Validate and Export RTL commands in the editor title;
- `.v/.sv` selectors and option priority unchanged.

Provider tests must assert `saveLayout` writes presentation nodes into the
document, excludes derived constant nodes, and `relayoutAll` clears manual
placement through one undoable edit.

**Step 2: Run and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicManifest.test.js
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
```

**Step 3: Register the provider and commands**

Create the provider beside the read-only schematic provider and reuse the same
workspace index services. Set `supportsMultipleEditorsPerDocument: false` so
one document revision owns one authoring surface.

Handle `saveLayout` and `relayoutAll` through `setPresentation` edits; do not
use `workspaceState` for `.ad` semantic placement.

**Step 4: Verify GREEN**

Run focused tests and `npm run vscode:prepublish --prefix veriflow-vscode`.

**Step 5: Commit**

```bash
git add veriflow-vscode/package.json veriflow-vscode/src/extension.ts \
  veriflow-vscode/src/archDesign veriflow-vscode/src/test
git commit -m "feat(vscode): register the Arch Design editor"
```

### Task 5: Add Authoring Controls And Editable Inspector Forms

**Files:**
- Modify: `packages/schematic-webview/src/index.html`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`

**Step 1: Write failing asset and support tests**

Assert the canonical source has Lucide buttons for add instance, add port,
connect, export, and delete with tooltips; AD-only controls are hidden by
default; dialogs and Inspector forms have stable IDs and labels; HDL mode still
renders the current read-only Inspector.

Add projection tests for instance, port, network, default, and export form
models derived from the authoring snapshot and selected graph objects.

**Step 2: Run and verify RED**

```bash
npm run vscode:prepublish --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicAssets.test.js
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
```

Expected: authoring controls and models are absent.

**Step 3: Implement minimal complete forms**

Render AD mode from `archDesignState`. Add modal forms for instances and ports;
editable Inspector rows for names, directions, widths, parameters, defaults,
connection names, and export settings; delete actions; and one-click export.

Every change posts a revision-bound typed edit and disables the changed control
until the host republishes. Do not optimistically mutate the design snapshot.
Keep labels inside the 280-pixel Inspector and use native inputs/selects rather
than text-shaped buttons for option values.

**Step 4: Verify GREEN and regenerate canonical assets**

```bash
npm run vscode:prepublish --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicAssets.test.js
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
npm run verify:generated
```

**Step 5: Commit**

```bash
git add packages/schematic-webview veriflow-vscode/src veriflow-vscode/web-dist/schematic
git commit -m "feat(webview): edit Arch Design properties"
```

### Task 6: Create And Edit Scalar Connections On The Canvas

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`

**Step 1: Write failing Electron tests**

In the real shared renderer:

- publish an editable AD graph and authoring state;
- drag an unconnected source pin to a receiver pin;
- assert exactly one `editArchDesign/connect` message contains the semantic
  endpoints and current revision;
- verify the temporary edge disappears before the host refresh;
- refresh with the new network and confirm normal orthogonal routing;
- rename/remove the selected network and edit a receiver default;
- verify read-only HDL pins never start a connection;
- repeat at a narrow viewport and assert toolbar/Inspector/canvas do not overlap.

**Step 2: Run and verify RED**

```bash
npm test --workspace @veriflow/waveform-desktop -- --test-name-pattern="Arch Design"
```

Expected: no AD connection interaction exists.

**Step 3: Implement pin drag authoring**

Enable X6 magnets only when the current authoring state is editable. Use one
temporary preview edge and validate that both terminals resolve to semantic AD
endpoints. Remove the preview on completion/cancel and post the typed connect
edit. Keep canonical network edges non-movable and preserve node/network
selection rules.

**Step 4: Verify GREEN**

Run the focused Electron tests, the complete desktop workspace tests, and
`npm run verify:generated`.

**Step 5: Commit**

```bash
git add packages/schematic-webview packages/waveform-desktop/test \
  veriflow-vscode/src/test veriflow-vscode/web-dist/schematic
git commit -m "feat(webview): connect Arch Design pins"
```

### Task 7: Validate And Export RTL From VS Code

**Files:**
- Create: `veriflow-vscode/src/archDesign/archDesignExport.ts`
- Create: `veriflow-vscode/src/test/archDesignExport.test.ts`
- Modify: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`

**Step 1: Write failing export adapter tests**

Test default sibling `.v`, configured `.sv`, relative output paths, extension
validation, portable source comments, output-definition exclusion, handwritten
target refusal, valid generated target replacement, temporary cleanup, and
write/rename failures preserving the previous target.

Provider tests assert Validate reports current diagnostic counts and Export
uses the latest revision/catalog, blocks semantic errors, and reports the
resolved output path only after publication succeeds.

**Step 2: Run and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/archDesignExport.test.js
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
```

**Step 3: Implement the Node extension-host adapter**

Call `validateArchDesign` and `exportArchDesignRtl` from the shared core. Use a
same-directory exclusive temporary file, recheck the target marker before
replacement, rename atomically, and remove only the owned temporary file on
failure. Never expose a force-overwrite path.

Wire both manifest commands and the webview export command to the active AD
provider snapshot.

**Step 4: Verify GREEN and CLI parity**

Run the focused tests plus:

```bash
npm test --workspace @veriflow/cli
npm run test:release
```

**Step 5: Commit**

```bash
git add veriflow-vscode/src/archDesign veriflow-vscode/src/test
git commit -m "feat(vscode): export Arch Design RTL"
```

### Task 8: Complete Documentation And Product Verification

**Files:**
- Modify: `README.md`
- Modify: `veriflow-vscode/README.md`
- Modify: `veriflow-vscode/README_zh-CN.md`
- Modify: `veriflow-vscode/CHANGELOG.md`
- Modify: `docs/DECISIONS.md`
- Modify: `veriflow-vscode/src/test/vsixPackaging.test.ts` if packaging coverage requires it

**Step 1: Add release-facing assertions first**

Require the packaged VSIX to contain the `.ad` custom editor contribution,
authoring assets, shared Arch Design runtime, and no Python artifacts. Extend
release smoke only where the published artifact behavior is not already
covered.

**Step 2: Run and verify RED**

```bash
npm run vscode:prepublish --prefix veriflow-vscode
node veriflow-vscode/out/test/vsixPackaging.test.js
```

**Step 3: Update concise documentation**

Keep the root README Chinese and usage-focused. Document opening `.ad`, adding
instances/ports, connecting pins, defaults, validation, and RTL export. Record
the separate-provider/shared-webview decision and explicitly defer interface
recognition.

**Step 4: Run the full verification matrix**

```bash
npm run verify:generated
npm run test:release
xvfb-run -a npm test
npm pack --dry-run --workspace @veriflow/schematic-core
npm pack --dry-run --workspace @veriflow/cli
git diff --check
git status --short --branch
```

Expected: all commands exit 0; Electron passes without blank canvas or overlap;
the only permitted skip is optional Icarus compilation when `iverilog` is not
installed; no generated package or temporary output remains untracked.

**Step 5: Request final code review and commit any review fixes**

Use `superpowers:requesting-code-review`, address findings with regression
tests, rerun the affected focused suites, then rerun the full matrix.

**Step 6: Commit**

```bash
git add README.md veriflow-vscode docs/DECISIONS.md
git commit -m "docs: document Arch Design editing"
```

## Follow-Up Phase

After this plan passes, implement protocol recognition, collapsed and expanded
AXI/APB/AHB interfaces, interface connections, effective interface defaults,
and project-defined protocol schemas. Keep that work outside the scalar editor
protocol introduced here.

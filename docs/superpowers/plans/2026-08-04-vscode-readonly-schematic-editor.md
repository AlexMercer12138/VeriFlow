# VS Code Read-Only Schematic Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, read-only schematic editor for one selected module in a Verilog/SystemVerilog file, with path-aware navigation, persisted layout, and a responsive AntV X6 canvas.

**Architecture:** Convert normalized module models into a renderer-neutral `SchematicGraph`, then send that serializable graph through a validated extension-host/Webview protocol. A custom editor provider shares indexed definitions but keeps text as the default editor; the Webview owns X6 rendering and interaction-only state, while VS Code owns files, layout persistence, and source navigation.

**Tech Stack:** TypeScript 5, VS Code Custom Text Editor API, AntV X6, @dagrejs/dagre, esbuild, CSS, Node assert tests

---

## Prerequisite

Complete the parser foundation and HDL feature migration plans first. This phase does not stage or apply source changes.

## Test File Convention

Keep imports at top level, put every shown test body inside `async function main(): Promise<void>`, and end with `void main().catch(error => { console.error(error); process.exitCode = 1; });`. Do not use top-level `await` under the CommonJS `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/src/schematic/graphModel.ts`: serializable nodes, pins, networks, source links, and graph diagnostics.
- Create `veriflow-vscode/src/schematic/graphBuilder.ts`: normalized HDL model to read-only graph conversion.
- Create `veriflow-vscode/src/schematic/layoutStore.ts`: viewport and node-coordinate persistence in `workspaceState`.
- Create `veriflow-vscode/src/schematic/navigationRegistry.ts`: exact target-module handoff and open panel tracking.
- Create `veriflow-vscode/src/schematic/protocol.ts`: discriminated host/Webview messages and runtime validation.
- Create `veriflow-vscode/src/schematic/schematicEditorProvider.ts`: optional custom editor and module selection.
- Create `veriflow-vscode/src/schematic/index.ts`: schematic extension-host exports.
- Create `veriflow-vscode/webview/schematic/index.ts`: X6 canvas, selection, search, toolbar, and navigation messages.
- Create `veriflow-vscode/webview/schematic/styles.css`: compact VS Code-themed layout.
- Create `veriflow-vscode/webview/schematic/index.html`: semantic Webview shell.
- Create `veriflow-vscode/src/test/schematicGraph.test.ts`: graph construction golden tests.
- Create `veriflow-vscode/src/test/schematicLayout.test.ts`: layout rematching tests.
- Create `veriflow-vscode/src/test/schematicProtocol.test.ts`: malformed-message rejection tests.
- Create `veriflow-vscode/src/test/schematicManifest.test.ts`: custom editor and command contribution tests.
- Create `veriflow-vscode/src/test/schematicAssets.test.ts`: packaged Webview asset tests.
- Create `veriflow-vscode/src/test/schematicIntegration.test.ts`: provider navigation and diagnostic tests.
- Create `veriflow-vscode/src/test/helpers/schematicProviderHarness.ts`: Node-only fake host/panel navigation harness.
- Modify `veriflow-vscode/scripts/build.mjs`: bundle the Webview and copy CSS/HTML.
- Modify `veriflow-vscode/.vscodeignore`: exclude unbundled Webview sources.
- Modify `.gitignore`: ignore generated schematic browser bundles.
- Modify `veriflow-vscode/package.json`: frontend dependencies, custom editor, commands, and menus.
- Modify `veriflow-vscode/src/extension.ts`: register provider and open commands.

### Task 1: Renderer-Neutral Schematic Graph Model

**Files:**
- Create: `veriflow-vscode/src/schematic/graphModel.ts`
- Create: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Create: `veriflow-vscode/src/test/fixtures/hdl/schematic-readonly.sv`
- Create: `veriflow-vscode/src/test/schematicGraph.test.ts`

- [ ] **Step 1: Write a failing graph golden test**

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import { buildSchematicGraph } from '../schematic/graphBuilder';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';
import { fixturePath } from './helpers/fixturePath';

const fixture = fixturePath('hdl', 'schematic-readonly.sv');
const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
const module = document.modules.find(item => item.name === 'top')!;
const graph = buildSchematicGraph(document, module, new Map());
assert.deepStrictEqual(graph.nodes.map(node => [node.kind, node.label]), [
  ['port', 'clk'], ['instance', 'u_child'], ['expression', "1'b1"], ['opaque', 'next_data'], ['port', 'done'],
]);
const child = graph.nodes.find(node => node.id === 'instance:u_child')!;
assert.strictEqual(child.subtitle, 'child');
assert.deepStrictEqual(child.pins.map(pin => [pin.name, pin.side]), [
  ['clk', 'left'], ['enable', 'left'], ['done', 'right'],
]);
assert.strictEqual(graph.networks.find(net => net.name === 'clk')?.endpoints.length, 2);
assert.strictEqual(graph.fileUri, document.uri);
assert.strictEqual(graph.moduleKey, module.id);
console.log('schematic graph tests passed');
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicGraph.test.js`

Expected: FAIL because `buildSchematicGraph` does not exist.

- [ ] **Step 3: Define stable graph contracts**

```typescript
import { HdlDiagnostic, SourceSpan, WidthValue } from '../core/hdl/model';

export type GraphNodeKind = 'port' | 'instance' | 'constant' | 'expression' | 'opaque' | 'generateArray';
export type PinDirection = 'driver' | 'load' | 'bidirectional';
export type GraphPin = {
  id: string; name: string; direction: PinDirection; side: 'left' | 'right' | 'bottom';
  width: WidthValue; sourceSpan?: SourceSpan;
};
export type GraphNode = {
  id: string; kind: GraphNodeKind; label: string; subtitle?: string;
  definitionKey?: string;
  pins: GraphPin[]; readOnly: boolean; sourceSpan?: SourceSpan;
};
export type NetworkEndpoint = { nodeId: string; pinId: string; role: PinDirection };
export type SchematicNetwork = {
  id: string; name: string; width: WidthValue; endpoints: NetworkEndpoint[];
  sourceSpan?: SourceSpan; adapterLabel?: string;
};
export type SchematicGraph = {
  fileUri: string; moduleKey: string; moduleName: string;
  nodes: GraphNode[]; networks: SchematicNetwork[]; diagnostics: HdlDiagnostic[];
};
```

- [ ] **Step 4: Implement deterministic read-only graph construction**

Create top-level input nodes first, then existing `inout`, instances and expression/opaque nodes in source order, then top-level outputs. Classify top-level inputs and instance outputs as drivers; top-level outputs and instance inputs as loads; use bidirectional for `inout`. Put the exact bound `definitionKey` on every resolvable instance node. Bind a connection to a named network when its expression resolves to a module-scope net or port; make constants and single raw expressions source nodes; make procedural or otherwise unresolved structural boundaries opaque nodes. Sort network endpoints by node order and pin order so repeated builds are stable.

An included-origin port/instance remains visible in its parent module, but mark its node/pin `readOnly` when its controlling declaration/token has `sourceSpan.uri !== document.uri` or `compositeParts`. Preserve the contiguous owning URI for source navigation and attach an `HDL_FOREIGN_SOURCE_READ_ONLY` info diagnostic. Add port-list-include and body-include graph fixtures asserting those objects render, navigate to the header URI, and expose no edit affordance in later phases.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicGraph.test.js`

Expected: graph golden, fan-out, top-level `inout`, constant, raw expression, unconnected pin, and opaque-boundary assertions pass.

- [ ] **Step 5: Commit graph construction**

```bash
git add veriflow-vscode/src/schematic/graphModel.ts veriflow-vscode/src/schematic/graphBuilder.ts veriflow-vscode/src/test/schematicGraph.test.ts veriflow-vscode/src/test/fixtures/hdl/schematic-readonly.sv
git commit -m "feat: build read-only schematic graphs"
```

### Task 2: Layout Persistence And Deterministic Auto-Layout

**Files:**
- Create: `veriflow-vscode/src/schematic/layoutStore.ts`
- Create: `veriflow-vscode/src/test/schematicLayout.test.ts`

- [ ] **Step 1: Write failing layout round-trip and rematch tests**

```typescript
const state = createMemoryMemento();
const store = new SchematicLayoutStore(state);
await store.save('file:///top.sv', 'module:top:0', {
  nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
  viewport: { x: 10, y: 20, zoom: 1.25 }, minimap: false,
});
assert.deepStrictEqual(store.load('file:///top.sv', 'module:top:0')?.viewport, { x: 10, y: 20, zoom: 1.25 });
const merged = mergeLayout(graph, store.load('file:///top.sv', 'module:top:0'));
assert.deepStrictEqual(merged.nodes['instance:u_child'], { x: 320, y: 120, fixed: true });
assert.ok(merged.nodes['port:clk'].x < merged.nodes['instance:u_child'].x);
```

- [ ] **Step 2: Run the layout test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicLayout.test.js`

Expected: FAIL because the layout store is missing.

- [ ] **Step 3: Implement versioned layout storage**

```typescript
export type NodeLayout = { x: number; y: number; fixed: boolean };
export type SchematicLayout = {
  nodes: Record<string, NodeLayout>;
  viewport: { x: number; y: number; zoom: number };
  minimap: boolean;
  selectedObjectId?: string;
};
export class SchematicLayoutStore {
  load(uri: string, moduleKey: string): SchematicLayout | undefined;
  save(uri: string, moduleKey: string, layout: SchematicLayout): Promise<void>;
  clearFixed(uri: string, moduleKey: string): Promise<SchematicLayout | undefined>;
}
```

Key state by encoded URI plus module identity. Clamp zoom to `0.1..4`, reject non-finite coordinates, discard node entries absent after reparse, and clear `selectedObjectId` when it no longer matches a node or network.

- [ ] **Step 4: Add deterministic left-to-right placement**

Use Dagre rank direction `LR`, fixed port columns, 48 px rank separation, and 24 px node separation. Keep manually fixed nodes unchanged during partial relayout. `Relayout All` clears `fixed` then recomputes every coordinate. Route feedback networks outside the main rank bounds and store only node/viewport state, never edge points.

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicLayout.test.js`

Expected: persistence, rematching, fixed-node, relayout-all, and input-left/output-right assertions pass.

- [ ] **Step 5: Commit layout support**

```bash
git add veriflow-vscode/src/schematic/layoutStore.ts veriflow-vscode/src/test/schematicLayout.test.ts
git commit -m "feat: persist schematic layouts"
```

### Task 3: Strict Host/Webview Protocol

**Files:**
- Create: `veriflow-vscode/src/schematic/protocol.ts`
- Create: `veriflow-vscode/src/test/schematicProtocol.test.ts`

- [ ] **Step 1: Write malformed-message rejection tests**

```typescript
import * as assert from 'assert';
import { parseWebviewCommand } from '../schematic/protocol';

assert.deepStrictEqual(parseWebviewCommand({ type: 'ready' }), { type: 'ready' });
assert.deepStrictEqual(parseWebviewCommand({ type: 'selectModule', moduleKey: 'file#module:top:0' }), {
  type: 'selectModule', moduleKey: 'file#module:top:0',
});
for (const value of [null, {}, { type: 'selectModule' }, { type: 'revealSource', span: { start: -1, end: 2 } }]) {
  assert.strictEqual(parseWebviewCommand(value), undefined);
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicProtocol.test.js`

Expected: FAIL because the protocol parser does not exist.

- [ ] **Step 3: Define messages and implement runtime validation**

```typescript
export type WebviewCommand =
  | { type: 'ready' }
  | { type: 'selectModule'; moduleKey: string }
  | { type: 'saveLayout'; moduleKey: string; layout: SchematicLayout }
  | { type: 'revealSource'; span: SourceSpan }
  | { type: 'openDefinition'; definitionKey: string }
  | { type: 'search'; query: string }
  | { type: 'relayoutAll'; moduleKey: string };
export type HostEvent =
  | { type: 'initialize'; fileUri: string; modules: Array<{ key: string; name: string }>; selectedModuleKey: string }
  | { type: 'graph'; graph: SchematicGraph; layout: SchematicLayout }
  | { type: 'diagnostics'; errors: number; warnings: number }
  | { type: 'hostError'; message: string };
export function parseWebviewCommand(value: unknown): WebviewCommand | undefined;
```

Use explicit object, string, finite-number, enum, and span checks for each message; accept an optional non-empty `span.uri` and validate ordered `compositeParts`, ignore unknown object properties, but reject unknown `type` values and invalid nested layouts.

- [ ] **Step 4: Verify protocol tests**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicProtocol.test.js`

Expected: all accepted and rejected message cases pass.

- [ ] **Step 5: Commit protocol validation**

```bash
git add veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/src/test/schematicProtocol.test.ts
git commit -m "feat: validate schematic webview messages"
```

### Task 4: Bundle The X6 Read-Only Canvas

**Files:**
- Create: `veriflow-vscode/webview/schematic/index.ts`
- Create: `veriflow-vscode/webview/schematic/styles.css`
- Create: `veriflow-vscode/webview/schematic/index.html`
- Modify: `veriflow-vscode/scripts/build.mjs`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `.gitignore`
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/THIRD_PARTY_NOTICES.md`
- Create: `veriflow-vscode/src/test/schematicAssets.test.ts`

- [ ] **Step 1: Add a failing Webview asset test**

```typescript
for (const relative of ['media/schematic/index.js', 'media/schematic/styles.css', 'media/schematic/index.html']) {
  assert.ok(fs.statSync(path.join(extensionRoot, relative)).size > 100, `${relative} is missing`);
}
assert.ok(fs.statSync(path.join(extensionRoot, 'media/schematic/index.js')).size > 50_000);
const notices = fs.readFileSync(path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
assert.ok(notices.includes('@antv/x6 3.1.7'));
assert.ok(notices.includes('@dagrejs/dagre 3.1.0'));
```

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicAssets.test.js`

Expected: FAIL because schematic assets have not been built.

- [ ] **Step 2: Add pinned frontend dependencies and build entry**

Add `@antv/x6` `3.1.7` and `@dagrejs/dagre` `3.1.0` as exact dependencies. Extend `scripts/build.mjs` with an esbuild browser bundle from `webview/schematic/index.ts` to `media/schematic/index.js`; copy HTML and CSS; use `platform: 'browser'`, `format: 'iife'`, `target: 'es2020'`, minification, `metafile: true`, and no source map in the package.

From the schematic esbuild metafile, collect every distinct `node_modules` package that contributed code, including transitive packages. Resolve each package's exact name/version and license file from its nearest `package.json`; fail the build when a bundled package has no declared license text. Regenerate `THIRD_PARTY_NOTICES.md` deterministically with the two parser sections from phase 1 followed by alphabetically sorted bundled frontend package sections. This inventory, rather than only the two direct dependencies, is the license boundary for the shipped browser bundle.

Append `webview/**` to `.vscodeignore`; the VSIX contains only freshly built `media/schematic/**`, not TypeScript Webview sources. Append `veriflow-vscode/media/schematic/` to the repository `.gitignore`: browser assets are deterministic build output, are regenerated by `npm run compile`/`vscode:prepublish`, and are not committed. Do not add `media/schematic/**` to `.vscodeignore`.

- [ ] **Step 3: Implement the stable canvas shell**

Use a three-row app grid: 36 px toolbar, flexible canvas, 24 px status strip. The toolbar contains icon buttons for fit, 100%, relayout, search, minimap, and text validation counts; the module selector stays leftmost. Use VS Code theme variables, 1 px borders, 4 px node radius, 12 px body text, and fixed pin rows so labels never resize nodes.

- [ ] **Step 4: Implement X6 graph rendering and read-only interactions**

Register port, instance, expression, opaque, and generate-array node shapes. Use orthogonal connectors, shared visual trunks for networks, directional markers only on pins, wheel zoom, background pan, box selection, multi-node movement, fit, 100%, search stepping, and conditional minimap activation. Escape all labels through DOM `textContent`; do not use graph labels as HTML. Post `saveLayout`, `revealSource`, `openDefinition`, and `relayoutAll` commands through the validated protocol.

- [ ] **Step 5: Build, test, and commit assets**

Run: `cd veriflow-vscode && npm install && npm run compile && node ./out/test/schematicAssets.test.js`

Expected: all three assets exist and the bundled canvas test passes.

```bash
git add .gitignore veriflow-vscode/webview/schematic veriflow-vscode/scripts/build.mjs veriflow-vscode/.vscodeignore veriflow-vscode/package.json veriflow-vscode/package-lock.json veriflow-vscode/THIRD_PARTY_NOTICES.md veriflow-vscode/src/test/schematicAssets.test.ts
git commit -m "feat: bundle X6 schematic canvas"
```

### Task 5: Optional Custom Editor And Entry Points

**Files:**
- Create: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Create: `veriflow-vscode/src/schematic/navigationRegistry.ts`
- Create: `veriflow-vscode/src/schematic/index.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/package.json`
- Create: `veriflow-vscode/src/test/schematicManifest.test.ts`

- [ ] **Step 1: Write failing manifest assertions**

```typescript
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const editor = manifest.contributes.customEditors.find((item: any) => item.viewType === 'veriflow.schematicEditor');
assert.strictEqual(editor.priority, 'option');
assert.deepStrictEqual(editor.selector.map((item: any) => item.filenamePattern), ['*.v', '*.sv']);
for (const id of ['veriflow.openSchematic', 'veriflow.openSchematicFromExplorer']) {
  assert.ok(manifest.contributes.commands.some((item: any) => item.command === id));
}
```

- [ ] **Step 2: Run the manifest test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicManifest.test.js`

Expected: FAIL because the custom editor and commands are absent.

- [ ] **Step 3: Register optional editor contributions**

Add `veriflow.schematicEditor` with `priority: "option"` and `.v`/`.sv` selectors. Add Command Palette, Explorer context, and editor-title commands. Each command calls `vscode.openWith(uri, SchematicEditorProvider.viewType)`; text remains the default editor.

- [ ] **Step 4: Implement provider initialization and module switching**

Define the navigation registry before constructing the provider:

```typescript
export type SchematicPanelHandle = {
  uri: string;
  reveal(): void;
  selectModule(definitionKey: string): Promise<void> | void;
};
export class SchematicNavigationRegistry {
  register(handle: SchematicPanelHandle): { dispose(): void };
  markFocused(handle: SchematicPanelHandle): void;
  findPreferred(uri: string): SchematicPanelHandle | undefined;
  setPending(uri: string, definitionKey: string): void;
  consumePending(uri: string): string | undefined;
}
```

Keep a set of panels per URI and return the most recently focused live handle, so multiple panels for one file do not overwrite each other. Pending targets are one-shot exact definition keys and are removed only by `consumePending`.

Register the `CustomTextEditorProvider` with `{ supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }`; the shared session registry, not VS Code's default single-editor reuse, owns consistency between panels. On resolve, parse the live `TextDocument`, list only modules in that URI, consume an exact pending module key from `SchematicNavigationRegistry` or select the first module, register the panel, load its layout, build its graph, and send `initialize` followed by `graph`. For a multi-module file, `selectModule` switches without reopening the document. Load the HTML shell, replace script/style placeholders with `webview.asWebviewUri(...)`, and set `localResourceRoots` to `media/schematic`. Use `default-src 'none'`, nonce-only script execution, `${webview.cspSource}` images/styles, and `'unsafe-inline'` only for X6's runtime style attributes; labels and expressions never become HTML.

- [ ] **Step 5: Verify and commit provider integration**

Run: `cd veriflow-vscode && npm test`

Expected: all parser, migration, graph, layout, protocol, asset, and manifest tests pass.

```bash
git add veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/schematic/navigationRegistry.ts veriflow-vscode/src/schematic/index.ts veriflow-vscode/src/extension.ts veriflow-vscode/package.json veriflow-vscode/src/test/schematicManifest.test.ts
git commit -m "feat: open HDL files as schematics"
```

### Task 6: Navigation, Diagnostics, And Read-Only Acceptance

**Files:**
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/navigationRegistry.ts`
- Modify: `veriflow-vscode/src/schematic/layoutStore.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`
- Modify: `veriflow-vscode/src/test/schematicGraph.test.ts`
- Create: `veriflow-vscode/src/test/schematicIntegration.test.ts`
- Create: `veriflow-vscode/src/test/helpers/schematicProviderHarness.ts`
- Modify: `veriflow-vscode/package.json`

- [ ] **Step 1: Add navigation and diagnostics integration assertions**

Create `src/test/helpers/schematicProviderHarness.ts` with this exact public surface:

```typescript
export type SchematicProviderHarness = {
  registry: SchematicNavigationRegistry;
  resolve(uri: string, moduleKeys: string[]): Promise<TestPanelHandle>;
  dispatch(panel: TestPanelHandle, command: WebviewCommand): Promise<void>;
  openedText: Array<{ uri: string; selection: { start: number; end: number } }>;
  openedSchematics: Array<{ uri: string; definitionKey: string }>;
  hostEvents: HostEvent[];
  diagnostics: Array<{ uri: string; count: number }>;
};
export type TestPanelHandle = SchematicPanelHandle & {
  selectedModuleKey: string; messages: HostEvent[]; disposed: boolean;
};
export function createSchematicProviderHarness(): SchematicProviderHarness;
```

Construct it with plain injected document/open/show/diagnostic ports, not the runtime `vscode` module. Assert `revealSource` opens the owning `span.uri` (falling back to the current document only when omitted) with the exact UTF-16 selection; an included-origin span opens its header file; `openDefinition` switches module in the same file or opens the target file schematically; two panels for one URI remain registered and the most recently focused one is preferred; diagnostic counts match graph diagnostics; returning to a module restores its selection and viewport.

- [ ] **Step 2: Run integration tests and verify missing handlers fail**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicIntegration.test.js`

Expected: FAIL until navigation, selection restore, and diagnostics forwarding are implemented.

- [ ] **Step 3: Implement source and definition navigation**

Resolve `span.uri ?? currentDocument.uri`, open that owning `TextDocument`, and convert the contiguous `SourceSpan` offsets through that document's `positionAt`. A composite span presents its ordered source parts and reveals the first part instead of applying composite offsets to one file. `revealSource` calls `showTextDocument` and sets the exact selection/reveal range. `openDefinition` requires the node's exact definition key and queries that definition. Same-file targets select the module in the current panel. `SchematicNavigationRegistry` tracks all open panels by URI plus a pending target module: if a target file already has a schematic panel, reveal the preferred panel and post `selectModule`; otherwise record the exact target key, execute `vscode.openWith`, and let the resolving provider consume that key instead of defaulting to the first module. VS Code navigation history tracks return navigation.

- [ ] **Step 4: Publish read-only diagnostics and selection state**

Create one `DiagnosticCollection` for source-mappable parser/graph issues. Send error/warning counts to the toolbar and detailed text to the inspector/status strip. Persist current selected object ID and viewport with layout; silently clear a selection that no longer rematches after reparse.

- [ ] **Step 5: Run completion verification and commit**

Run: `cd veriflow-vscode && npm test && npm run lint && npm run package`

Expected: zero test/lint failures; VSIX includes bundled schematic assets; `.v`/`.sv` remain text by default and open schematically only through explicit entry points.

```bash
git add veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/schematic/navigationRegistry.ts veriflow-vscode/src/schematic/layoutStore.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/src/test/helpers/schematicProviderHarness.ts veriflow-vscode/src/test/schematicIntegration.test.ts veriflow-vscode/src/test/schematicProtocol.test.ts veriflow-vscode/src/test/schematicGraph.test.ts veriflow-vscode/package.json
git commit -m "feat: complete read-only schematic navigation"
```

## Plan Completion Gate

Run from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run package
```

Expected results:

- explicit Open With, Command Palette, Explorer, and editor-title entry points work while text stays default;
- a multi-module file switches one module per canvas;
- inputs, outputs, existing `inout`, instances, constants, expressions, opaque boundaries, and orthogonal fan-out render deterministically;
- graph labels are escaped text, protocol messages are validated, and the CSP rejects unapproved resources;
- layout, fixed nodes, selection, viewport, search, source reveal, and definition navigation behave as specified;
- no graph action modifies the source document in this phase.

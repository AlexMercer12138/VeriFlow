# VS Code Schematic Editing Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only schematic into a staged, undoable graph editor with shared file sessions, persistent drafts, definition binding, and structural validation, while still leaving source text untouched.

**Architecture:** Represent every user mutation as a serializable `GraphEditCommand` reduced over an immutable base graph. One `SchematicSession` per document URI owns module journals, definition bindings, diagnostics, and panel subscriptions; graph drafts persist in extension workspace storage, while coordinates and viewport remain in the separate layout store.

**Tech Stack:** TypeScript 5, VS Code extension API, AntV X6, normalized HDL/index models, Node assert tests

---

## Prerequisite

Complete the read-only schematic plan first. Source preview and application remain disabled until the source round-trip plan is complete.

## Test File Convention

Keep imports at top level, put every shown test body inside `async function main(): Promise<void>`, and end with `void main().catch(error => { console.error(error); process.exitCode = 1; });`. Do not use top-level `await` under the CommonJS `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/src/schematic/editModel.ts`: editable graph objects, generated identities, and command union.
- Create `veriflow-vscode/src/schematic/commandReducer.ts`: deterministic command validation and reduction.
- Create `veriflow-vscode/src/schematic/commandJournal.ts`: per-module undo/redo and replay.
- Create `veriflow-vscode/src/schematic/graphValidator.ts`: identifier, direction, driver, endpoint, and binding diagnostics.
- Create `veriflow-vscode/src/schematic/draftStore.ts`: versioned draft persistence under extension workspace storage.
- Create `veriflow-vscode/src/schematic/schematicSession.ts`: shared file session and conflict lifecycle.
- Create `veriflow-vscode/src/schematic/sessionRegistry.ts`: URI-keyed session reference management.
- Create `veriflow-vscode/src/test/schematicCommands.test.ts`: command/reducer/journal tests.
- Create `veriflow-vscode/src/test/schematicValidation.test.ts`: direction, driver, identifier, and binding tests.
- Create `veriflow-vscode/src/test/schematicDraft.test.ts`: restart, restore, conflict, and discard tests.
- Create `veriflow-vscode/src/test/schematicSession.test.ts`: multi-panel and document-change tests.
- Create `veriflow-vscode/src/test/schematicEditingIntegration.test.ts`: provider-to-session command forwarding tests.
- Create `veriflow-vscode/src/test/helpers/schematicFixture.ts`: deterministic editable graph and validation fixtures.
- Create `veriflow-vscode/src/test/helpers/schematicSessionFixture.ts`: fake documents, panels, storage, and registry harness.
- Modify `veriflow-vscode/src/schematic/protocol.ts`: editing commands and session events.
- Modify `veriflow-vscode/src/schematic/schematicEditorProvider.ts`: acquire/release shared sessions.
- Modify `veriflow-vscode/webview/schematic/index.ts`: palette, drag/connect, inspector, delete, undo, and redo.
- Modify `veriflow-vscode/webview/schematic/styles.css`: editing palette and inspector layout.
- Modify `veriflow-vscode/package.json`: run session tests.

### Task 1: Editable Graph State And Command Reducer

**Files:**
- Create: `veriflow-vscode/src/schematic/editModel.ts`
- Create: `veriflow-vscode/src/schematic/commandReducer.ts`
- Create: `veriflow-vscode/src/test/helpers/schematicFixture.ts`
- Create: `veriflow-vscode/src/test/schematicCommands.test.ts`

- [ ] **Step 1: Write failing command-reduction tests**

```typescript
import * as assert from 'assert';
import { reduceGraphCommand } from '../schematic/commandReducer';
import { editableFixture } from './helpers/schematicFixture';

let state = editableFixture();
state = reduceGraphCommand(state, {
  type: 'addInstance', commandId: 'c1', moduleKey: state.moduleKey,
  instanceId: 'new:instance:1', definitionKey: 'file:///child.sv#module:child:0',
  moduleName: 'child', instanceName: 'u_child_1',
}).state;
assert.strictEqual(state.nodes['new:instance:1'].label, 'u_child_1');
state = reduceGraphCommand(state, {
  type: 'renameInstance', commandId: 'c2', moduleKey: state.moduleKey,
  instanceId: 'new:instance:1', name: 'u_pipe',
}).state;
assert.strictEqual(state.nodes['new:instance:1'].label, 'u_pipe');
assert.throws(() => reduceGraphCommand(state, {
  type: 'addPort', commandId: 'c3', moduleKey: state.moduleKey,
  portId: 'new:port:1', name: 'bus', direction: 'inout', packedRange: '[7:0]',
}), /new inout ports are not supported/);
const included = includedOriginFixture();
assert.throws(() => reduceGraphCommand(included, {
  type: 'renamePort', commandId: 'c4', moduleKey: included.moduleKey,
  portId: 'included:port:clk', name: 'renamed_clk',
}), /read-only source/);
console.log('schematic command tests passed');
```

Add `includedOriginFixture()` to `src/test/helpers/schematicFixture.ts`; it returns a complete `EditableGraphState` containing `included:port:clk` with `readOnly: true` and a contiguous source span owned by `file:///ports.svh` while `state.fileUri` is `file:///top.sv`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicCommands.test.js`

Expected: FAIL because the editable model and reducer do not exist.

- [ ] **Step 3: Define serializable editable state and commands**

```typescript
export type ObjectOrigin = 'source' | 'draft';
export type EditableParameterState = {
  defaultExpression?: string;
  overrideExpression?: string;
  explicitOrigin: 'none' | 'source' | 'draft';
};
export type EditableNode = GraphNode & {
  origin: ObjectOrigin; definitionKey?: string; parameters?: Record<string, EditableParameterState>;
  portState?: { direction: 'input' | 'output' | 'inout'; originalDirection: 'input' | 'output' | 'inout' };
};
export type EditableNetwork = SchematicNetwork & { origin: ObjectOrigin; explicitName: boolean };
export type EditableGraphState = {
  fileUri: string; moduleKey: string; nodes: Record<string, EditableNode>;
  networks: Record<string, EditableNetwork>; diagnostics: HdlDiagnostic[];
  definitions: Record<string, HdlDefinitionSummary>;
  nextGeneratedId: number;
};
type CommandBase = { commandId: string; moduleKey: string };
export type GraphEditCommand = CommandBase & (
  | { type: 'addInstance'; instanceId: string; definitionKey: string; moduleName: string; instanceName: string }
  | { type: 'deleteNode'; nodeId: string }
  | { type: 'renameInstance'; instanceId: string; name: string }
  | { type: 'setParameter'; instanceId: string; parameterName: string; expression?: string }
  | { type: 'addPort'; portId: string; name: string; direction: 'input' | 'output'; packedRange?: string }
  | { type: 'renamePort'; portId: string; name: string }
  | { type: 'setPort'; portId: string; direction: 'input' | 'output' | 'inout'; packedRange?: string }
  | { type: 'addConstant'; nodeId: string; expression: string }
  | { type: 'setConstant'; nodeId: string; expression: string }
  | { type: 'connect'; networkId: string; endpoints: NetworkEndpoint[]; requestedName?: string }
  | { type: 'branch'; networkId: string; endpoint: NetworkEndpoint }
  | { type: 'disconnect'; networkId: string; endpoint: NetworkEndpoint }
  | { type: 'renameNetwork'; networkId: string; name: string }
);
```

- [ ] **Step 4: Implement pure reduction with exact failure results**

```typescript
export type CommandResult = { state: EditableGraphState; changedObjectIds: string[] };
export class GraphCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function reduceGraphCommand(state: EditableGraphState, command: GraphEditCommand): CommandResult;
```

Clone only the touched node/network maps. Reject a mismatched module key, missing object, duplicate command-created identity, edits to `readOnly` objects, unsupported new `inout`, or a parameter absent from the bound definition. The graph builder marks every composite-span or foreign-origin object read-only, so the same guard rejects changes to declarations coming from an included file while leaving source navigation enabled. `setPort` may retain `inout` only when `origin === 'source'` and `portState.originalDirection === 'inout'`; it may change that existing port to input/output, but it may not turn another port into `inout`. `setConstant` updates the displayed/source expression without replacing node identity. Deleting a node removes its endpoints; delete a draft network left with fewer than two endpoints, but keep an existing source network as a zero/one-endpoint staged state for diagnostics.

For `setParameter`, a value different from the default becomes a draft explicit override. Clearing/restoring the default removes only a draft override; an override explicitly present in source retains `explicitOrigin: 'source'` even when its text equals the current default, so an unrelated graph edit never silently removes it.

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicCommands.test.js`

Expected: add/delete/rename/parameter/port/constant/connect/branch/disconnect/network-rename and immutable-input assertions pass.

- [ ] **Step 5: Commit editable model and reducer**

```bash
git add veriflow-vscode/src/schematic/editModel.ts veriflow-vscode/src/schematic/commandReducer.ts veriflow-vscode/src/test/schematicCommands.test.ts veriflow-vscode/src/test/helpers/schematicFixture.ts
git commit -m "feat: reduce schematic edit commands"
```

### Task 2: Direction, Driver, Identifier, And Binding Validation

**Files:**
- Create: `veriflow-vscode/src/schematic/graphValidator.ts`
- Modify: `veriflow-vscode/src/test/helpers/schematicFixture.ts`
- Create: `veriflow-vscode/src/test/schematicValidation.test.ts`
- Modify: `veriflow-vscode/src/schematic/commandReducer.ts`

- [ ] **Step 1: Write failing validation tests**

```typescript
const valid = validateEditableGraph(oneDriverTwoLoadsFixture());
assert.strictEqual(valid.filter(item => item.severity === 'error').length, 0);

const drivers = validateEditableGraph(twoDriversFixture());
assert.ok(drivers.some(item => item.code === 'SCHEMATIC_MULTIPLE_DRIVERS' && item.severity === 'error'));

const unbound = validateEditableGraph(ambiguousDefinitionFixture());
assert.ok(unbound.some(item => item.code === 'SCHEMATIC_AMBIGUOUS_DEFINITION'));

assert.strictEqual(validateIdentifier('valid_name'), undefined);
assert.strictEqual(validateIdentifier('1bad')?.code, 'SCHEMATIC_INVALID_IDENTIFIER');
assert.strictEqual(validateIdentifier('wire')?.code, 'SCHEMATIC_RESERVED_IDENTIFIER');
```

Add `oneDriverTwoLoadsFixture`, `twoDriversFixture`, and `ambiguousDefinitionFixture` to `src/test/helpers/schematicFixture.ts`; each returns a complete `EditableGraphState` with its definition catalog and stable object IDs.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicValidation.test.js`

Expected: FAIL because graph validation is missing.

- [ ] **Step 3: Implement explicit direction rules**

```typescript
export type SchematicDiagnostic = HdlDiagnostic & { objectIds: string[]; blocking: boolean };
export function validateIdentifier(name: string): SchematicDiagnostic | undefined;
export function classifyEndpoint(node: EditableNode, pin: GraphPin): 'driver' | 'load' | 'bidirectional';
export function validateEditableGraph(state: EditableGraphState): SchematicDiagnostic[];
```

Allow one driver plus any loads. Reject driver-to-driver, load-only networks, illegal input/input or output/output pin connections, and known `inout` width mismatches. Mark missing new-instance definitions, ambiguous definition bindings, duplicate names in module scope, and edits to read-only constructs as blocking. Warn for unconnected instance inputs, undriven top outputs, symbolic/unknown widths, and deleted-port references.

- [ ] **Step 4: Allocate deterministic instance and network names**

```typescript
export function allocateName(preferred: string, used: ReadonlySet<string>): string {
  if (!used.has(preferred)) return preferred;
  for (let suffix = 1; ; suffix++) if (!used.has(`${preferred}_${suffix}`)) return `${preferred}_${suffix}`;
}
```

New instances use `u_<module_name>`; new networks use the unique driver pin/port name. Sanitize only the automatically suggested base; user-entered invalid names remain visible with blocking diagnostics instead of being silently changed.

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicValidation.test.js && node ./out/test/schematicCommands.test.js`

Expected: direction, name allocation, duplicates, binding, disconnected, and `inout` tests pass.

- [ ] **Step 5: Commit structural validation**

```bash
git add veriflow-vscode/src/schematic/graphValidator.ts veriflow-vscode/src/schematic/commandReducer.ts veriflow-vscode/src/test/helpers/schematicFixture.ts veriflow-vscode/src/test/schematicValidation.test.ts
git commit -m "feat: validate staged schematic edits"
```

### Task 3: Per-Module Command Journal And Undo/Redo

**Files:**
- Create: `veriflow-vscode/src/schematic/commandJournal.ts`
- Modify: `veriflow-vscode/src/test/schematicCommands.test.ts`

- [ ] **Step 1: Write failing replay and branch tests**

```typescript
const journal = new CommandJournal(baseState);
journal.execute(renameA);
journal.execute(renameB);
assert.strictEqual(journal.current.nodes.instance.label, 'u_b');
journal.undo();
assert.strictEqual(journal.current.nodes.instance.label, 'u_a');
journal.execute(renameC);
assert.strictEqual(journal.canRedo, false);
assert.deepStrictEqual(journal.commands.map(item => item.commandId), ['rename-a', 'rename-c']);
assert.deepStrictEqual(CommandJournal.restore(baseState, journal.serialize()).current, journal.current);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicCommands.test.js`

Expected: FAIL because `CommandJournal` is absent.

- [ ] **Step 3: Implement replay-based journal semantics**

```typescript
export type SerializedJournal = { commands: GraphEditCommand[]; cursor: number };
export class CommandJournal {
  constructor(readonly base: EditableGraphState);
  get current(): EditableGraphState;
  get commands(): readonly GraphEditCommand[];
  get canUndo(): boolean;
  get canRedo(): boolean;
  execute(command: GraphEditCommand): EditableGraphState;
  undo(): EditableGraphState;
  redo(): EditableGraphState;
  serialize(): SerializedJournal;
  static restore(base: EditableGraphState, value: SerializedJournal): CommandJournal;
}
```

Rebuild from base through `cursor` on restore and undo/redo. Executing after undo truncates the redo suffix. Reject duplicate command IDs during restore. Cap a module journal at 2,000 commands and compact by replacing its base only after source application in phase 5, never while an unapplied draft exists.

- [ ] **Step 4: Verify journal behavior**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicCommands.test.js`

Expected: replay, undo, redo, redo truncation, duplicate ID, corrupt command, and per-module isolation assertions pass.

- [ ] **Step 5: Commit journal support**

```bash
git add veriflow-vscode/src/schematic/commandJournal.ts veriflow-vscode/src/test/schematicCommands.test.ts
git commit -m "feat: add schematic graph undo and redo"
```

### Task 4: Persistent Graph Drafts Separate From Layout

**Files:**
- Create: `veriflow-vscode/src/schematic/draftStore.ts`
- Create: `veriflow-vscode/src/test/schematicDraft.test.ts`

- [ ] **Step 1: Write failing restart, conflict, and discard tests**

```typescript
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'veriflow-drafts-'));
const store = new SchematicDraftStore(root);
const baseline = {
  documentVersion: 1, sourceHash: 'hash-a', preprocessingFingerprint: 'pp-a',
  definitionFingerprints: { 'file:///child.sv#module:child:0': 'child-a' },
};
await store.save({
  schemaVersion: 1, draftId: 'draft-1', fileUri: 'file:///top.sv', baseline,
  modules: { 'module:top:0': journal.serialize() }, definitionBindings: {}, updatedAt: 10,
});
assert.strictEqual((await store.load('file:///top.sv', baseline)).status, 'restorable');
assert.strictEqual((await store.load('file:///top.sv', { ...baseline, preprocessingFingerprint: 'pp-b' })).status, 'conflict');
assert.strictEqual((await store.load('file:///top.sv', {
  ...baseline, definitionFingerprints: { 'file:///child.sv#module:child:0': 'child-b' },
})).status, 'conflict');
await store.discard('file:///top.sv');
assert.strictEqual((await store.load('file:///top.sv', baseline)).status, 'missing');
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicDraft.test.js`

Expected: FAIL because `SchematicDraftStore` is missing.

- [ ] **Step 3: Implement atomic storage under extension workspace storage**

```typescript
export type SchematicSemanticBaseline = {
  documentVersion: number;
  sourceHash: string;
  preprocessingFingerprint: string;
  definitionFingerprints: Record<string, string>;
};
export type SchematicDraft = {
  schemaVersion: 1; draftId: string; fileUri: string; baseline: SchematicSemanticBaseline;
  modules: Record<string, SerializedJournal>;
  definitionBindings: Record<string, Record<string, string>>;
  updatedAt: number;
};
export type DraftLoadResult =
  | { status: 'missing' }
  | { status: 'restorable'; draft: SchematicDraft }
  | { status: 'conflict'; draft: SchematicDraft };
export class SchematicDraftStore {
  constructor(private readonly storagePath: string);
  load(fileUri: string, baseline: SchematicSemanticBaseline): Promise<DraftLoadResult>;
  save(draft: SchematicDraft): Promise<void>;
  discard(fileUri: string): Promise<void>;
}
```

Hash the URI into a filesystem-safe filename. The extension host passes `context.storageUri.fsPath`, but this core store uses only Node path/fs APIs so tests do not load the `vscode` module. Write JSON to a sibling temporary file and rename it atomically. Validate schema, URI, the complete semantic baseline, command discriminants, cursor bounds, and binding strings on load. Draft JSON contains no node coordinates, viewport, or minimap state. Restore requires equal source hash, preprocessing fingerprint, and every bound definition fingerprint; document version is informative across restart and is reset to the newly opened document after equality is established.

- [ ] **Step 4: Verify corrupt and concurrent-save recovery**

Add assertions that invalid JSON returns `missing` after being renamed to `.corrupt`, the newer `updatedAt` wins, and source-hash, include/define preprocessing-fingerprint, or bound-definition-fingerprint mismatches never replay commands.

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/schematicDraft.test.js`

Expected: lifecycle, validation, and atomic-save assertions pass.

- [ ] **Step 5: Commit draft persistence**

```bash
git add veriflow-vscode/src/schematic/draftStore.ts veriflow-vscode/src/test/schematicDraft.test.ts
git commit -m "feat: persist schematic graph drafts"
```

### Task 5: Shared File Sessions And Source Conflict State

**Files:**
- Create: `veriflow-vscode/src/schematic/schematicSession.ts`
- Create: `veriflow-vscode/src/schematic/sessionRegistry.ts`
- Create: `veriflow-vscode/src/test/helpers/schematicSessionFixture.ts`
- Create: `veriflow-vscode/src/test/schematicSession.test.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`

- [ ] **Step 1: Write failing multi-panel session tests**

```typescript
const registry = createSessionRegistryHarness([
  'module a; endmodule', 'module b; endmodule', '',
].join('\n'));
const sinkA: TestEventSink = { events: [] };
const sinkB: TestEventSink = { events: [] };
const panelA = registry.acquire('file:///multi.sv', sinkA);
const panelB = registry.acquire('file:///multi.sv', sinkB);
assert.strictEqual(panelA.session, panelB.session);
panelA.session.execute('module:a:0', renameCommand);
assert.ok(sinkA.events.some(event => event.type === 'sessionChanged'));
assert.ok(sinkB.events.some(event => event.type === 'sessionChanged'));
registry.documents.change('file:///multi.sv', 2, 'changed source');
assert.strictEqual(panelA.session.status, 'conflict');
assert.strictEqual(panelA.session.canGenerate, false);
```

Create `src/test/helpers/schematicSessionFixture.ts` with this exact public surface:

```typescript
export type SessionRegistryHarness = {
  registry: SessionRegistry;
  documents: { change(uri: string, version: number, text: string): void };
  semantics: { invalidate(uri: string, preprocessingFingerprint: string, definitionFingerprints?: Record<string, string>): void };
  acquire(uri: string, sink: TestEventSink): { session: SchematicSession; dispose(): void };
};
export type TestEventSink = { events: SessionEvent[] };
export function createSessionRegistryHarness(source: string): SessionRegistryHarness;
```

The harness uses the real parser worker helper, memory layout/state objects, a temporary draft directory, and event sinks with `events: SessionEvent[]`.

- [ ] **Step 2: Run the session test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicSession.test.js`

Expected: FAIL because shared sessions are missing.

- [ ] **Step 3: Implement one session per URI**

```typescript
export type SessionStatus = 'clean' | 'dirty' | 'conflict';
export type SessionEvent =
  | { type: 'sessionChanged'; moduleKey: string; graph: EditableGraphState; canUndo: boolean; canRedo: boolean; diagnostics: SchematicDiagnostic[] }
  | { type: 'statusChanged'; status: SessionStatus; canGenerate: boolean }
  | { type: 'draftStatus'; status: 'missing' | 'saved' | 'restored' | 'conflict' | 'discarded' }
  | { type: 'sourceReloaded'; moduleKeys: string[] };
export class SchematicSession {
  readonly uri: string;
  readonly baseline: SchematicSemanticBaseline;
  get status(): SessionStatus;
  get canGenerate(): boolean;
  getGraph(moduleKey: string): EditableGraphState;
  execute(moduleKey: string, command: GraphEditCommand): Promise<void>;
  undo(moduleKey: string): Promise<void>;
  redo(moduleKey: string): Promise<void>;
  bindDefinition(moduleKey: string, instanceId: string, definitionKey: string): Promise<void>;
  reloadFromSource(): Promise<void>;
  discardDraft(): Promise<void>;
  subscribe(sink: (event: SessionEvent) => void): vscode.Disposable;
}
```

The registry reference-counts panels and keeps a dirty session alive after the final panel closes long enough to flush its draft. Definition bindings are addressed by `(moduleKey, instanceId)` and persisted under the matching module key, so identical instance names/IDs in two modules cannot collide. Resolve every bound definition and capture its `modelFingerprint` in the baseline. Reopening restores automatically only with the same semantic baseline. A text document version/hash change, include/define preprocessing fingerprint change, or bound external-definition fingerprint change marks all modules and panels conflicted, invalidates any preview, disables generation, and never silently rebases commands. `WorkspaceHdlIndex` invalidation events notify the session registry even when the primary `TextDocument` did not change.

Extend the session test by creating a dirty parent session, then changing only an included header, changing only `veriflow.defines`, and changing only a bound child module's ports/parameters. Each change must produce `status === 'conflict'`, disable generation, and leave the journal intact for explicit reload/discard. A clean session may refresh its base graph automatically, but a dirty session never does.

- [ ] **Step 4: Wire provider panels to shared sessions**

Acquire by `document.uri.toString()` in `resolveCustomTextEditor`; subscribe each panel; release on disposal. Module selectors may show different module journals in different panels. Implement `Reload From Source` as discarding the in-memory commands after an explicit Webview command; implement `Discard Graph Draft` as clearing journal plus persisted draft. Neither action edits source.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicSession.test.js`

Expected: multi-panel broadcast, independent module journals, close/reopen restore, source conflict, reload, discard, and registry disposal assertions pass.

- [ ] **Step 5: Commit shared sessions**

```bash
git add veriflow-vscode/src/schematic/schematicSession.ts veriflow-vscode/src/schematic/sessionRegistry.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/test/helpers/schematicSessionFixture.ts veriflow-vscode/src/test/schematicSession.test.ts
git commit -m "feat: share schematic editing sessions"
```

### Task 6: Editing Palette, Inspector, And Canvas Commands

**Files:**
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/webview/schematic/styles.css`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Create: `veriflow-vscode/src/test/schematicEditingIntegration.test.ts`
- Modify: `veriflow-vscode/package.json`

- [ ] **Step 1: Add protocol and integration tests for every edit command**

```typescript
const commands = [
  { type: 'execute', command: addInput }, { type: 'execute', command: addOutput },
  { type: 'execute', command: addConstant }, { type: 'execute', command: addInstance },
  { type: 'execute', command: connect }, { type: 'execute', command: branch },
  { type: 'execute', command: renameNetwork }, { type: 'execute', command: setParameter },
  { type: 'execute', command: deletePort }, { type: 'undo', moduleKey }, { type: 'redo', moduleKey },
];
for (const command of commands) assert.ok(parseWebviewCommand(command));
```

The fake panel test must assert one host/session event per accepted command and a structured `commandRejected` event for an invalid command.

- [ ] **Step 2: Run integration tests and verify protocol failure**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicEditingIntegration.test.js`

Expected: FAIL because edit commands are not accepted or forwarded.

- [ ] **Step 3: Add validated editing messages**

Extend `WebviewCommand` with `execute`, `undo`, `redo`, `bindDefinition`, `reloadFromSource`, and `discardDraft`. Extend `HostEvent` with `sessionChanged`, `commandRejected`, `draftStatus`, and `conflict`. Validate the full nested `GraphEditCommand` by discriminant and exact required fields before calling the session.

- [ ] **Step 4: Implement editing UI without source generation**

Add a 220 px left palette and 280 px right inspector around the existing unframed canvas. Palette commands add Input, Output, Constant, and a path-qualified searched module. X6 pin drag creates/branches networks; Delete and context menu delete selected editable objects. Inspector edits instance name/parameters, port name/direction/width, network name, and constant expression. Toolbar undo/redo follows the active module journal. The Generate button displays validation counts but remains disabled with tooltip `Source generation is not available in this build` until phase 5.

- [ ] **Step 5: Verify Webview and commit the editing phase**

Run: `cd veriflow-vscode && npm test && npm run lint && npm run package`

Expected: zero failures; edit messages are validated; drafts survive restart; no code path calls `WorkspaceEdit` or writes the HDL document.

```bash
git add veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/webview/schematic/styles.css veriflow-vscode/src/test/schematicEditingIntegration.test.ts veriflow-vscode/package.json
git commit -m "feat: edit staged schematic graphs"
```

## Plan Completion Gate

Run from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run package
rg -n "WorkspaceEdit|applyEdit|TextEditorEdit" src/schematic webview/schematic
```

Expected results:

- add/delete/rename/connect/branch/disconnect/parameter actions work as staged commands;
- new ports are input/output only, while existing `inout` remains representable;
- duplicate identifiers, illegal directions, multiple drivers, missing bindings, and known `inout` mismatch are blocking diagnostics;
- all open panels for a file share commands and conflict state while retaining independent module selection/layout;
- graph undo/redo and crash-safe drafts work independently of layout persistence;
- the final source-edit API search returns no matches in session/editor implementation for this phase.

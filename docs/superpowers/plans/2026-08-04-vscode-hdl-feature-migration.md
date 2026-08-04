# VS Code HDL Feature Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every existing Verilog/SystemVerilog structural source consumer with one persistent `WorkspaceHdlIndex` backed by the normalized parser model.

**Architecture:** Build a workspace index above `HdlParserClient`, persist only serializable summaries, and expose exact definition identities instead of one-path-per-name maps. Adapt the existing scan, dependency, instantiation, and Testbench flows to the index while preserving their user-visible output and keeping `formatModuleInstantiation` as the only instance renderer.

**Tech Stack:** TypeScript 5, VS Code extension API, Tree-sitter parser facade from phase 1, Node assert tests, VSCE

---

## Prerequisite

Complete `docs/superpowers/plans/2026-08-04-vscode-hdl-parser-foundation.md` first. The types and parser client named below are the exact public contracts created by that plan.

## Test File Convention

Keep imports at top level, put every shown test body inside `async function main(): Promise<void>`, and end with `void main().catch(error => { console.error(error); process.exitCode = 1; });`. Do not use top-level `await` under the CommonJS `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/src/core/hdl/workspaceIndexTypes.ts`: persisted summaries, exact definition keys, and query results.
- Create `veriflow-vscode/src/core/hdl/workspaceIndexStore.ts`: versioned workspace-storage serialization.
- Create `veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts`: initial scan, incremental refresh, include invalidation, queries, and duplicate diagnostics.
- Create `veriflow-vscode/src/core/hdl/legacyModelAdapter.ts`: temporary conversion from normalized definitions to existing UI types.
- Create `veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts`: index, persistence, watcher, and duplicate tests.
- Create `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`: regression and legacy-parser guard tests.
- Create `veriflow-vscode/src/test/helpers/workspaceIndexFixture.ts`: in-memory files, store, and parser instrumentation for index tests.
- Modify `veriflow-vscode/src/core/hdl/model.ts`: include relations and declaration line metadata needed by summaries.
- Modify `veriflow-vscode/src/core/hdl/index.ts`: export the index API.
- Modify `veriflow-vscode/src/core/dependencyAnalyzer.ts`: resolve dependencies through exact indexed definitions.
- Modify `veriflow-vscode/src/core/types.ts`: retain compatibility shapes while adding exact definition identities.
- Modify `veriflow-vscode/src/core/moduleInstantiationChoices.ts`: build path-qualified choices from all indexed definitions.
- Modify `veriflow-vscode/src/moduleInstantiationCommand.ts`: query the index instead of `PortParser`.
- Modify `veriflow-vscode/src/core/testbenchGenerator.ts`: consume already-resolved ports and parameters and stop parsing source files.
- Modify `veriflow-vscode/src/testbenchPanel.ts`: populate module entries from the index.
- Modify `veriflow-vscode/src/moduleTreeProvider.ts`: render exact indexed definitions.
- Modify `veriflow-vscode/src/extension.ts`: own the index, watchers, scan status, and duplicate summaries.
- Modify `veriflow-vscode/src/core/index.ts`: remove structural regex-parser exports after migration.
- Modify `veriflow-vscode/src/test/core.test.ts`: preserve exact feature behavior against the new index.
- Modify `veriflow-vscode/package.json`: run the new tests.
- Delete `veriflow-vscode/src/core/portParser.ts`: remove the legacy structural parser after all callers migrate.

### Task 1: Stable Workspace Index Contracts And Persistence

**Files:**
- Create: `veriflow-vscode/src/core/hdl/workspaceIndexTypes.ts`
- Create: `veriflow-vscode/src/core/hdl/workspaceIndexStore.ts`
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Create: `veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts`

- [ ] **Step 1: Write a failing round-trip persistence test**

```typescript
import * as assert from 'assert';
import { WorkspaceIndexStore } from '../core/hdl/workspaceIndexStore';
import { PersistedWorkspaceIndex } from '../core/hdl/workspaceIndexTypes';

const memory = new Map<string, unknown>();
const memento = {
  get: <T>(key: string): T | undefined => memory.get(key) as T | undefined,
  update: async (key: string, value: unknown): Promise<void> => { memory.set(key, value); },
};
const value: PersistedWorkspaceIndex = {
  schemaVersion: 1,
  parserFingerprint: 'sv-0.4.0:defines-a',
  files: [{
    uri: 'file:///workspace/child.sv', mtimeMs: 12, size: 31, contentHash: 'abc',
    includeUris: [], diagnostics: [],
    definitions: [{
      key: 'file:///workspace/child.sv#module:child:0', kind: 'module', name: 'child',
      uri: 'file:///workspace/child.sv', declarationStart: 0, declarationLine: 1,
      parameters: [], ports: [], dependencies: [], modelFingerprint: 'model-child-a',
    }],
  }],
};

const store = new WorkspaceIndexStore(memento);
await store.save(value);
assert.deepStrictEqual(store.load('sv-0.4.0:defines-a'), value);
assert.strictEqual(store.load('different-fingerprint'), undefined);
console.log('HDL workspace index tests passed');
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlWorkspaceIndex.test.js`

Expected: FAIL because `WorkspaceIndexStore` and the summary types do not exist.

- [ ] **Step 3: Define exact serializable index types**

```typescript
import { HdlDiagnostic, WidthValue } from './model';

export type HdlDefinitionKind = 'module' | 'interface' | 'package';
export type HdlDefinitionKey = string;
export type IndexedParameterSummary = { name: string; defaultExpression?: string };
export type IndexedPortSummary = {
  name: string; direction: 'input' | 'output' | 'inout'; packedRange?: string; width: WidthValue;
};
export type HdlDefinitionSummary = {
  key: HdlDefinitionKey;
  kind: HdlDefinitionKind;
  name: string;
  uri: string;
  declarationStart: number;
  declarationLine: number;
  parameters: IndexedParameterSummary[];
  ports: IndexedPortSummary[];
  dependencies: string[];
  modelFingerprint: string;
};
export type HdlFileSummary = {
  uri: string; mtimeMs: number; size: number; contentHash: string;
  includeUris: string[]; definitions: HdlDefinitionSummary[]; diagnostics: HdlDiagnostic[];
};
export type PersistedWorkspaceIndex = {
  schemaVersion: 1; parserFingerprint: string; files: HdlFileSummary[];
};
```

Reuse the foundation's `HdlDocument.includes: IncludeModel[]`. The CST adapter records raw active include paths/spans; the workspace index fills `resolvedUri` from its canonical include graph without narrowing or duplicating the document property. Compute `modelFingerprint` from the normalized definition structure and every source/include content hash that contributed to it; it changes when port order, parameter defaults, packed ranges, or included structural fragments change even if the containing file text does not.

- [ ] **Step 4: Implement the versioned store and pass the test**

```typescript
import { PersistedWorkspaceIndex } from './workspaceIndexTypes';

type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};

const KEY = 'veriflow.hdlWorkspaceIndex.v1';

export class WorkspaceIndexStore {
  constructor(private readonly state: MementoLike) {}
  load(parserFingerprint: string): PersistedWorkspaceIndex | undefined {
    const value = this.state.get<PersistedWorkspaceIndex>(KEY);
    return value?.schemaVersion === 1 && value.parserFingerprint === parserFingerprint ? value : undefined;
  }
  async save(value: PersistedWorkspaceIndex): Promise<void> { await this.state.update(KEY, value); }
  async clear(): Promise<void> { await this.state.update(KEY, undefined); }
}
```

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlWorkspaceIndex.test.js`

Expected: `HDL workspace index tests passed`.

- [ ] **Step 5: Commit index contracts**

```bash
git add veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/workspaceIndexTypes.ts veriflow-vscode/src/core/hdl/workspaceIndexStore.ts veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts
git commit -m "feat: define persistent HDL workspace index"
```

### Task 2: Initial Scan, Incremental Refresh, And Duplicate Reporting

**Files:**
- Create: `veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts`
- Modify: `veriflow-vscode/src/core/hdl/index.ts`
- Create: `veriflow-vscode/src/test/helpers/workspaceIndexFixture.ts`
- Modify: `veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts`

- [ ] **Step 1: Add failing scan and invalidation assertions**

```typescript
const harness = createWorkspaceIndexHarness({
  'file:///ws/a.sv': 'module shared(input logic a); child u_child(); endmodule',
  'file:///ws/b.v': 'module shared(output b); endmodule',
  'file:///ws/child.v': 'module child; endmodule',
});
const index = harness.index;
await index.scan(['file:///ws']);
assert.strictEqual(index.findDefinitions('shared').length, 2);
assert.deepStrictEqual(index.findDefinitions('shared').map(item => item.uri).sort(), [
  'file:///ws/a.sv', 'file:///ws/b.v',
]);
assert.deepStrictEqual(index.getDefinition(index.findDefinitions('child')[0].key)?.dependencies, []);
assert.strictEqual(index.getDuplicateGroups()[0].name, 'shared');

harness.files.set('file:///ws/child.v', 'module child2; endmodule');
await index.refreshUri('file:///ws/child.v');
assert.strictEqual(index.findDefinitions('child').length, 0);
assert.strictEqual(index.findDefinitions('child2').length, 1);
```

Create `src/test/helpers/workspaceIndexFixture.ts` with this public harness; implement its injected `findFiles`, `readFile`, `resolveInclude`, in-memory `WorkspaceIndexStore`, and parser-call counter entirely with Node types so the test never imports `vscode`:

```typescript
export type WorkspaceIndexHarness = {
  index: WorkspaceHdlIndex;
  files: Map<string, string>;
  parserCalls: Array<{ uri: string; priority: 'interactive' | 'background' }>;
};
export function createWorkspaceIndexHarness(initial: Record<string, string>): WorkspaceIndexHarness;
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlWorkspaceIndex.test.js`

Expected: FAIL because `WorkspaceHdlIndex` is missing.

- [ ] **Step 3: Implement the query and refresh API**

```typescript
export type DuplicateDefinitionGroup = { name: string; definitions: HdlDefinitionSummary[] };
export type WorkspaceIndexInvalidation = {
  changedUris: string[];
  affectedDocumentUris: string[];
  changedDefinitionKeys: HdlDefinitionKey[];
  parserFingerprint: string;
};
export type WorkspaceHdlIndexOptions = {
  parser: HdlParserClient;
  store: WorkspaceIndexStore;
  parserFingerprint: string;
  defines: Record<string, string | true>;
  findFiles(roots: string[]): Promise<string[]>;
  readFile(uri: string): Promise<{ text: string; version: number; mtimeMs: number; size: number }>;
  resolveInclude(fromUri: string, includePath: string): Promise<string | undefined>;
};

export class WorkspaceHdlIndex {
  async load(): Promise<void>;
  async scan(roots: string[], signal?: AbortSignal): Promise<void>;
  async refreshUri(uri: string, signal?: AbortSignal): Promise<void>;
  async removeUri(uri: string): Promise<void>;
  async updateConfiguration(defines: Record<string, string | true>): Promise<void>;
  findDefinitions(name: string, kind?: HdlDefinitionKind): HdlDefinitionSummary[];
  getDefinition(key: HdlDefinitionKey): HdlDefinitionSummary | undefined;
  resolveDefinition(key: HdlDefinitionKey): Promise<{ summary: HdlDefinitionSummary; document: HdlDocument; module?: ModuleModel }>;
  getFile(uri: string): HdlFileSummary | undefined;
  getAllDefinitions(kind?: HdlDefinitionKind): HdlDefinitionSummary[];
  getDuplicateGroups(): DuplicateDefinitionGroup[];
  getDependentsOfInclude(uri: string): string[];
  onDidInvalidate(listener: (event: WorkspaceIndexInvalidation) => void): { dispose(): void };
  dispose(): void;
}
```

Use URI strings as keys. Accept `.v`, `.sv`, `.vh`, and `.svh`; header files contribute include relations but only actual parsed declarations enter definition queries. When a composite parent parse contains a complete definition originating in an included file, index it only when `definition.nameSpan.uri` equals the currently indexed document URI; included port/body fragments still remain part of their owning parent `ModuleModel`. Resolve includes through configured include/library directories and pass a canonical `ResolvedIncludeInput[]` graph keyed by `(fromUri, rawPath)`; add fixtures with two different `common.svh` files and a nested relative include. Invalidate includers when any transitive resolved-URI hash changes. `resolveDefinition` reparses or reuses the full normalized document and returns the exact module model for module definitions; summaries never persist CST objects. Sort every public result by name, then URI, then declaration offset. Persist after a completed scan or refresh batch, not once per file.

Every index parse calls `parser.parse(..., 'background')`. Check `signal?.throwIfAborted()` before reading each file, before parsing it, and before committing its summary; on abort, discard the incomplete batch and do not persist it. The extension owns one `AbortController` for the active watcher/configuration batch and aborts it when a newer batch supersedes it. Interactive document/custom-editor parses use the parser client's default priority, so once the current synchronous Tree-sitter call finishes they overtake queued index files.

After one completed atomic batch, emit one `WorkspaceIndexInvalidation` listing changed physical files, all transitive includers whose preprocessing fingerprints changed, and definition keys whose `modelFingerprint` changed. Open schematic sessions subscribe through `SessionRegistry`; this is how an include, define configuration, or bound child-definition edit invalidates a dirty parent session whose primary document hash/version stayed unchanged.

- [ ] **Step 4: Add include and unchanged-file cache assertions**

Add a fixture where `top.sv` includes `defs.svh`. Assert changing `defs.svh` reparses `top.sv`; rescanning unchanged `{mtimeMs,size,contentHash}` files does not invoke `parser.parse` again; a define fingerprint change invalidates every active-branch summary. Assert every recorded scan call has background priority. Start a delayed three-file scan, abort after the first parse, and assert files two and three are never parsed, no partial batch is persisted, and a later interactive parser request is selected before a queued background request.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlWorkspaceIndex.test.js`

Expected: persistence, duplicate, incremental refresh, include invalidation, and configuration assertions all pass.

- [ ] **Step 5: Commit the workspace index**

```bash
git add veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts veriflow-vscode/src/core/hdl/index.ts veriflow-vscode/src/test/helpers/workspaceIndexFixture.ts veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts
git commit -m "feat: index workspace HDL definitions"
```

### Task 3: Dependency Analysis Through Exact Definitions

**Files:**
- Modify: `veriflow-vscode/src/core/dependencyAnalyzer.ts`
- Modify: `veriflow-vscode/src/core/types.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Convert dependency tests to injected indexed definitions**

```typescript
const analyzer = new DependencyAnalyzer(index);
const topKey = index.findDefinitions('top')[0].key;
const result = analyzer.resolve(topKey);
assert.strictEqual(result.topModule, 'top');
assert.deepStrictEqual(result.files.map(path.basename), ['leaf.v', 'child.v', 'top.v']);
assert.deepStrictEqual(result.depGraph.top, ['child']);
assert.deepStrictEqual(result.missingModules, []);
```

Add a duplicate `child` definition and assert `resolve(topKey)` returns an `ambiguousModules` entry with both definition keys instead of silently choosing the first path.

- [ ] **Step 2: Run the dependency tests and verify signature failure**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/core.test.js`

Expected: FAIL because `DependencyAnalyzer` still accepts search directories and scans source with regex.

- [ ] **Step 3: Replace source scanning with index traversal**

```typescript
export interface DependencyResult {
  topModule: string;
  topDefinitionKey: string;
  files: string[];
  missingModules: string[];
  ambiguousModules: Record<string, string[]>;
  moduleMap: Record<string, string>;
  depGraph: Record<string, string[]>;
}

export class DependencyAnalyzer {
  constructor(private readonly index: WorkspaceHdlIndex) {}
  resolve(topDefinitionKeyOrUniqueName: string, bindings: Record<string, string> = {}): DependencyResult;
}
```

Resolve an exact key directly; accept a module name only when the index contains one definition. Traverse `HdlDefinitionSummary.dependencies`. Resolve a dependency name only when it has one definition or `bindings[name]` selects one of its keys. Preserve dependency-before-parent topological file order and include files before their including file. Report unresolved names in `missingModules` and duplicate unbound names in `ambiguousModules`. In `extension.ts`, construct the analyzer from the lazy workspace index during `activate` and stop passing search directories to `resolve`; module scanning itself migrates in Task 4.

- [ ] **Step 4: Run all legacy dependency fixtures against the new analyzer**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/core.test.js`

Expected: conditional compilation, generate, procedural-statement rejection, missing module, duplicate binding, include ordering, and cycle tests pass.

- [ ] **Step 5: Commit dependency migration**

```bash
git add veriflow-vscode/src/core/dependencyAnalyzer.ts veriflow-vscode/src/core/types.ts veriflow-vscode/src/extension.ts veriflow-vscode/src/test/core.test.ts
git commit -m "refactor: resolve dependencies from HDL index"
```

### Task 4: Module Scan, Tree, And Duplicate Status Integration

**Files:**
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/config.ts`
- Modify: `veriflow-vscode/src/moduleTreeProvider.ts`
- Modify: `veriflow-vscode/src/core/types.ts`
- Create: `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`

- [ ] **Step 1: Write manifest and duplicate-presentation tests**

```typescript
const source = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
assert.ok(source.includes('new WorkspaceHdlIndex'));
assert.ok(!source.includes('MODULE_DECL_RE'));
assert.ok(!source.includes('_scanModulesInternal'));

const summary = formatDuplicateSummary([{ name: 'alu', definitions: [a, b] }]);
assert.ok(summary.outputLines.some(line => line.includes('alu') && line.includes(a.uri)));
assert.strictEqual(summary.statusText, '$(warning) VeriFlow: 1 duplicate module name');
assert.strictEqual(summary.popupMessage, undefined);
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlFeatureMigration.test.js`

Expected: FAIL because extension scanning still contains `MODULE_DECL_RE` and `_scanModulesInternal`.

- [ ] **Step 3: Adapt scan results without losing duplicate paths**

```typescript
export interface ModuleDefinitionEntry {
  key: string; name: string; uri: string; filepath: string; line: number; workspace: boolean;
}
export interface ModuleScanResult {
  root: string; libDirs: string[]; totalModules: number;
  modules: string[]; workspaceModules: string[];
  definitions: ModuleDefinitionEntry[];
  duplicates: Record<string, string[]>;
  modulesByDir: Record<string, string[]>;
  moduleFiles: Record<string, string>;
}
```

Make `cmdScanModules` await `workspaceHdlIndex.scan()`, derive this compatibility view, and feed it to the tree and Testbench panel. Keep `modulesByDir` and the first-definition `moduleFiles` map only until Task 6 migrates the Testbench panel; no new picker may consume that lossy map. `ModuleTreeProvider` must create one item per definition and set `description` to a workspace-relative path when a name is duplicated.

Persist the top selection as an exact identity:

```typescript
export type TopModuleSelection = { definitionKey: string; name: string };
export function getTopModule(context: vscode.ExtensionContext): TopModuleSelection | undefined;
export function setTopModule(context: vscode.ExtensionContext, selection: TopModuleSelection | undefined): Promise<void>;
```

`cmdSelectTop` builds Quick Pick items from workspace module definitions and shows a relative path for duplicates. The dependency analyzer receives `definitionKey`; simulator command templates still receive `selection.name`. Migrate an old stored name only when the index has one exact workspace definition, otherwise clear it and require selection without showing a popup.

- [ ] **Step 4: Register incremental file and configuration updates**

Create one watcher for `**/*.{v,sv,vh,svh}`. Its create/change/delete callbacks call index refresh/remove, refresh the tree, and recompute the duplicate summary. `veriflow.defines` or `veriflow.libDirs` changes trigger a complete indexed scan. Log one consolidated duplicate block to `VeriFlow` Output Channel and set status text; never call `showWarningMessage` for duplicates.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlFeatureMigration.test.js`

Expected: structural scanning has no regex dependency and duplicate presentation has no popup path.

- [ ] **Step 5: Commit scan integration**

```bash
git add veriflow-vscode/src/extension.ts veriflow-vscode/src/config.ts veriflow-vscode/src/moduleTreeProvider.ts veriflow-vscode/src/core/types.ts veriflow-vscode/src/test/hdlFeatureMigration.test.ts
git commit -m "refactor: scan modules through HDL index"
```

### Task 5: One-Click Instantiation Migration

**Files:**
- Create: `veriflow-vscode/src/core/hdl/legacyModelAdapter.ts`
- Modify: `veriflow-vscode/src/core/moduleInstantiationChoices.ts`
- Modify: `veriflow-vscode/src/moduleInstantiationCommand.ts`
- Modify: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Add exact-definition picker tests**

```typescript
const choices = buildModuleInstantiationChoices(index.getAllDefinitions('module'));
assert.deepStrictEqual(choices.map(item => [item.moduleName, item.description]), [
  ['alu', 'rtl/alu.sv'],
  ['alu', 'vendor/alu.v'],
  ['fifo', 'rtl/fifo.sv'],
]);
assert.notStrictEqual(choices[0].definitionKey, choices[1].definitionKey);
```

Assert parameter defaults and ports passed to `formatModuleInstantiation` are read from the selected `HdlDefinitionSummary`, and preserve the existing alignment golden string exactly.

- [ ] **Step 2: Run the formatter and picker tests and verify failure**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/core.test.js`

Expected: FAIL because the picker still consumes the lossy `moduleFiles` map and reparses using `PortParser`.

- [ ] **Step 3: Implement the normalized-to-UI adapter**

```typescript
import * as path from 'path';
import { fileURLToPath } from 'url';

export function toModuleInfo(definition: HdlDefinitionSummary): ModuleInfo {
  const filepath = fileURLToPath(definition.uri);
  return {
    name: definition.name,
    parameters: definition.parameters.map(item => ({ name: item.name, value: item.defaultExpression ?? item.name })),
    ports: definition.ports.map(item => ({ name: item.name, direction: item.direction, width: item.packedRange })),
    filename: path.basename(filepath),
    filepath,
    dependencies: [...definition.dependencies],
    isTB: false,
  };
}
```

Change `showModuleInstantiationPicker` to accept `WorkspaceHdlIndex`, select `definitionKey`, fetch that exact summary, and keep the existing second quick-pick for Insert at Cursor versus Copy to Clipboard.

- [ ] **Step 4: Verify both command paths**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/core.test.js && node ./out/test/hdlFeatureMigration.test.js`

Expected: duplicate definitions appear separately by path; insert and copy use the chosen definition; the existing aligned text remains byte-for-byte equal.

- [ ] **Step 5: Commit instantiation migration**

```bash
git add veriflow-vscode/src/core/hdl/legacyModelAdapter.ts veriflow-vscode/src/core/moduleInstantiationChoices.ts veriflow-vscode/src/moduleInstantiationCommand.ts veriflow-vscode/src/test/core.test.ts
git commit -m "refactor: instantiate modules from HDL index"
```

### Task 6: Testbench Migration And Legacy Parser Removal

**Files:**
- Modify: `veriflow-vscode/src/core/testbenchGenerator.ts`
- Modify: `veriflow-vscode/src/testbenchPanel.ts`
- Modify: `veriflow-vscode/src/core/types.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/core/index.ts`
- Modify: `veriflow-vscode/src/test/core.test.ts`
- Modify: `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`
- Modify: `veriflow-vscode/package.json`
- Delete: `veriflow-vscode/src/core/portParser.ts`

- [ ] **Step 1: Change Testbench fixtures to pass resolved structure**

```typescript
export interface TbModuleConfig {
  definitionKey: string;
  module_name: string;
  instance_name: string;
  ports: Port[];
  parameters: Parameter[];
  port_signals: Record<string, string>;
  param_values: Record<string, string>;
}
```

Update the existing `testTestbenchGenerator` fixture with `ports` and `parameters`; keep its exact expected module declaration, signal declarations, and aligned instance string unchanged.

- [ ] **Step 2: Run the Testbench test and verify type failure**

Run: `cd veriflow-vscode && npm run compile:ts`

Expected: FAIL until `TestbenchGenerator` stops constructing `PortParser` and accepts the resolved fields.

- [ ] **Step 3: Remove parsing from Testbench generation**

Delete `_parser`, `_parseModule`, and all `PortParser` imports. In `_build`, replace source parsing with:

```typescript
const allParsed = modules.map(mod => ({
  mod,
  ports: mod.ports,
  params: mod.parameters,
}));
```

Make `TestbenchPanelProvider` accept `WorkspaceHdlIndex`; store a `definitionKey` in each `TbModuleEntry`; resolve the exact summary when adding a module; convert it through `toModuleInfo`; and pass those ports and parameters into `TbModuleConfig`.

Remove the temporary `modulesByDir` and `moduleFiles` compatibility fields from `ModuleScanResult`, remove `setModuleMap`, and pass the index to both the tree and Testbench panel. The tree continues deriving directory groups from `definitions`.

- [ ] **Step 4: Add and pass the no-legacy-parser guard**

```typescript
const structuralConsumers = [
  'src/extension.ts', 'src/core/dependencyAnalyzer.ts', 'src/moduleInstantiationCommand.ts',
  'src/core/testbenchGenerator.ts', 'src/testbenchPanel.ts',
];
for (const relative of structuralConsumers) {
  const text = fs.readFileSync(path.join(extensionRoot, relative), 'utf8');
  assert.ok(!text.includes('PortParser'), `${relative} still uses PortParser`);
  assert.ok(!text.includes('MODULE_DECL_RE'), `${relative} still scans modules with regex`);
}
assert.ok(!fs.existsSync(path.join(extensionRoot, 'src/core/portParser.ts')));
```

Run: `cd veriflow-vscode && npm test`

Expected: all legacy core tests and new migration tests pass, and no structural HDL consumer uses the removed parser.

- [ ] **Step 5: Package and commit the completed migration**

Run: `cd veriflow-vscode && npm run lint && npm run package`

Expected: ESLint reports zero errors and VSCE packages successfully.

```bash
git add veriflow-vscode/src/core/testbenchGenerator.ts veriflow-vscode/src/testbenchPanel.ts veriflow-vscode/src/core/types.ts veriflow-vscode/src/extension.ts veriflow-vscode/src/core/index.ts veriflow-vscode/src/test/core.test.ts veriflow-vscode/src/test/hdlFeatureMigration.test.ts veriflow-vscode/package.json
git rm veriflow-vscode/src/core/portParser.ts
git commit -m "refactor: complete unified HDL parser migration"
```

## Plan Completion Gate

Run from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run package
rg -n "PortParser|MODULE_DECL_RE|INST_RE|new Function" src
```

Expected results:

- all tests report zero failures and the VSIX packages successfully;
- the final search finds no structural source parsing through `PortParser`, `MODULE_DECL_RE`, or `INST_RE`;
- `new Function` may remain only in the old Testbench width evaluator until semantic hardening phase 6 replaces it, and must not parse HDL structure;
- duplicate definitions are preserved as path-qualified entries and reported only through Output Channel/status bar;
- scan, dependency analysis, instantiation, and Testbench generation all consume `WorkspaceHdlIndex` summaries.

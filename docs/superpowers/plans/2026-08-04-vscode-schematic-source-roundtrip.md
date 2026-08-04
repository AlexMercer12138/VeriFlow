# VS Code Schematic Source Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert staged graph journals into minimal, validated Verilog/SystemVerilog edits, show the complete result in VS Code's native Diff Editor, and apply it as one atomic undoable workspace edit.

**Architecture:** Specialized planners emit preconditioned `SourcePatchEdit` objects against normalized source spans; one file-level planner merges edits from every modified module, validates non-overlap, reparses the candidate, and publishes it through a read-only virtual document. Apply rechecks version, hash, candidate identity, and old text immediately before one `WorkspaceEdit` replacement.

**Tech Stack:** TypeScript 5, VS Code WorkspaceEdit and TextDocumentContentProvider APIs, normalized HDL model, shared module instantiation formatter, Node assert tests

---

## Prerequisite

Complete the staged editing-session plan first. Positional/wildcard instances, generate templates, and width adapters remain blocked until the semantic-hardening plan.

## Test File Convention

Keep imports at top level, put every shown test body inside `async function main(): Promise<void>`, and end with `void main().catch(error => { console.error(error); process.exitCode = 1; });`. Do not use top-level `await` under the CommonJS `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/src/schematic/sourcePatch.ts`: edit contracts, overlap/precondition validation, and in-memory application.
- Create `veriflow-vscode/src/schematic/sourceStyle.ts`: line endings, indentation, grouped declaration, and insertion anchors.
- Create `veriflow-vscode/src/schematic/planDelta.ts`: cursor-aware base-to-current semantic change coalescing.
- Create `veriflow-vscode/src/schematic/instancePatchPlanner.ts`: existing named instance edits and new/deleted instances.
- Create `veriflow-vscode/src/schematic/portPatchPlanner.ts`: ANSI/non-ANSI add/delete/rename and boundary assignments.
- Create `veriflow-vscode/src/schematic/networkPatchPlanner.ts`: net declarations, continuous assignments, and resolved symbol renames.
- Create `veriflow-vscode/src/schematic/connectionSourcePlanner.ts`: inline versus materialized constant/expression source decisions.
- Create `veriflow-vscode/src/schematic/sourcePlanner.ts`: file-level journal-to-patch orchestration.
- Create `veriflow-vscode/src/schematic/candidateValidator.ts`: base/candidate parse comparison and diagnostics.
- Create `veriflow-vscode/src/schematic/diffPreviewProvider.ts`: candidate virtual documents and preview identity.
- Create `veriflow-vscode/src/schematic/sourceApplication.ts`: second precondition check and atomic `WorkspaceEdit`.
- Create `veriflow-vscode/src/test/sourcePatch.test.ts`: overlap, old-text, ordering, LF/CRLF, and untouched-slice tests.
- Create `veriflow-vscode/src/test/instancePatchPlanner.test.ts`: named instance and formatter tests.
- Create `veriflow-vscode/src/test/portPatchPlanner.test.ts`: ANSI/non-ANSI add/delete tests.
- Create `veriflow-vscode/src/test/networkPatchPlanner.test.ts`: declaration, assign, rename, and materialization tests.
- Create `veriflow-vscode/src/test/sourceRoundTrip.test.ts`: candidate parse, diff, conflict, and atomic-apply integration.
- Create `veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts`: normalized source contexts and command constructors for patch tests.
- Modify `veriflow-vscode/src/schematic/schematicSession.ts`: preview/apply lifecycle and post-apply refresh.
- Modify `veriflow-vscode/src/schematic/schematicEditorProvider.ts`: Generate, Apply, Discard Preview commands.
- Modify `veriflow-vscode/src/schematic/protocol.ts`: generation and preview events.
- Modify `veriflow-vscode/webview/schematic/index.ts`: enable Generate and preview actions.
- Modify `veriflow-vscode/package.json`: run patch and integration tests.

### Task 1: Preconditions And Atomic In-Memory Patch Application

**Files:**
- Create: `veriflow-vscode/src/schematic/sourcePatch.ts`
- Create: `veriflow-vscode/src/test/sourcePatch.test.ts`

- [ ] **Step 1: Write failing patch ordering and precondition tests**

```typescript
import * as assert from 'assert';
import { applySourcePatchPlan, SourcePatchError } from '../schematic/sourcePatch';

const source = 'module top;\n  wire old;\nendmodule\n';
const plan = {
  fileUri: 'file:///top.sv', baseVersion: 3, baseHash: 'hash-a',
  preprocessingFingerprint: 'pp-a', definitionFingerprints: {},
  edits: [
    { span: { start: 19, end: 22 }, expectedText: 'old', replacementText: 'renamed', moduleKey: 'top', operation: 'renameNetwork' },
    { span: { start: 24, end: 24 }, expectedText: '', replacementText: '  assign renamed = 1\'b0;\n', moduleKey: 'top', operation: 'addAssignment' },
  ],
} satisfies SourcePatchPlan;
assert.strictEqual(applySourcePatchPlan(source, plan).text, 'module top;\n  wire renamed;\n  assign renamed = 1\'b0;\nendmodule\n');
assert.throws(() => applySourcePatchPlan(source.replace('old', 'new'), plan), (error: unknown) =>
  error instanceof SourcePatchError && error.code === 'PATCH_OLD_TEXT_MISMATCH');
assert.throws(() => applySourcePatchPlan(source, { ...plan, edits: [
  { ...plan.edits[0], span: { start: 19, end: 23 } },
  { ...plan.edits[0], span: { start: 21, end: 22 } },
]}), /overlap/);
assert.throws(() => applySourcePatchPlan(source, { ...plan, edits: [
  { ...plan.edits[0], span: { uri: 'file:///included.svh', start: 0, end: 3 } },
]}), (error: unknown) => error instanceof SourcePatchError && error.code === 'PATCH_FOREIGN_FILE_SPAN');
assert.throws(() => applySourcePatchPlan(source, { ...plan, edits: [
  { ...plan.edits[0], span: { start: 0, end: 3, compositeParts: [
    { uri: 'file:///top.sv', start: 0, end: 1 },
    { uri: 'file:///included.svh', start: 0, end: 2 },
  ] } },
]}), (error: unknown) => error instanceof SourcePatchError && error.code === 'PATCH_COMPOSITE_SPAN');
console.log('source patch tests passed');
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/sourcePatch.test.js`

Expected: FAIL because the source patch API does not exist.

- [ ] **Step 3: Define patch and failure contracts**

```typescript
export type SourcePatchOperation =
  | 'replaceConnection' | 'replaceParameter' | 'renameInstance' | 'rewriteInstance' | 'deleteInstance'
  | 'addInstance' | 'addPort' | 'deletePort' | 'renamePort' | 'changePort' | 'renameNetwork'
  | 'addNet' | 'addAssignment' | 'deleteDraftObject';
export type SourcePatchEdit = {
  span: SourceSpan; expectedText: string; replacementText: string;
  moduleKey: string; operation: SourcePatchOperation;
};
export type SourcePatchPlan = {
  fileUri: string; baseVersion: number; baseHash: string;
  preprocessingFingerprint: string;
  definitionFingerprints: Record<string, string>;
  edits: SourcePatchEdit[];
};
export class SourcePatchError extends Error {
  constructor(readonly code: 'PATCH_INVALID_SPAN' | 'PATCH_FOREIGN_FILE_SPAN' | 'PATCH_COMPOSITE_SPAN' | 'PATCH_OVERLAP' | 'PATCH_OLD_TEXT_MISMATCH', message: string) { super(message); }
}
export function applySourcePatchPlan(source: string, plan: SourcePatchPlan): { text: string; touchedModules: string[] };
```

- [ ] **Step 4: Implement all-or-nothing end-to-start application**

First validate every integer span and exact source slice. Resolve an omitted `span.uri` to `plan.fileUri`, reject a contiguous span owned by another URI with `PATCH_FOREIGN_FILE_SPAN`, and reject any `compositeParts` with `PATCH_COMPOSITE_SPAN`; the current candidate is always one physical file. Sort a copy by `start DESC, end DESC`; reject overlapping non-empty spans and conflicting insertions at one offset; allow same-offset insertions only after the planner has merged them into one edit. Only after all validation succeeds, apply edits end-to-start. Return a deduplicated source-order list of touched module keys.

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/sourcePatch.test.js`

Expected: ordering, insertion, deletion, overlap, expected-text, UTF-16, and no-partial-result tests pass.

- [ ] **Step 5: Commit the patch primitive**

```bash
git add veriflow-vscode/src/schematic/sourcePatch.ts veriflow-vscode/src/test/sourcePatch.test.ts
git commit -m "feat: apply preconditioned source patches"
```

### Task 2: Source Style And Safe Insertion Anchors

**Files:**
- Create: `veriflow-vscode/src/schematic/sourceStyle.ts`
- Modify: `veriflow-vscode/src/test/sourcePatch.test.ts`

- [ ] **Step 1: Write failing LF, CRLF, indent, and anchor tests**

```typescript
const lf = inferSourceStyle('module top;\n    wire a;\nendmodule\n', moduleModel);
assert.deepStrictEqual(lf, { lineEnding: '\n', indent: '    ', finalNewline: true });
const crlf = inferSourceStyle('module top;\r\n\twire a;\r\nendmodule', moduleModel);
assert.deepStrictEqual(crlf, { lineEnding: '\r\n', indent: '\t', finalNewline: false });
assert.strictEqual(findInsertionAnchors(moduleModel).instance, moduleModel.endmoduleSpan.start);
assert.ok(findInsertionAnchors(moduleModel).net <= findInsertionAnchors(moduleModel).assignment);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/sourcePatch.test.js`

Expected: FAIL because style and anchor helpers are absent.

- [ ] **Step 3: Implement model-driven source style helpers**

```typescript
export type SourceStyle = { lineEnding: '\n' | '\r\n'; indent: string; finalNewline: boolean };
export type InsertionAnchors = { net: number; assignment: number; instance: number };
export function inferSourceStyle(source: string, module: ModuleModel): SourceStyle;
export function findInsertionAnchors(module: ModuleModel): InsertionAnchors;
export function indentBlock(text: string, indent: string, lineEnding: string): string;
```

Infer indentation from existing module-scope declarations/instances, falling back to four spaces. Net insertion follows the final parameter/port/net declaration and precedes the first process or instance. Assignment insertion follows declarations and existing continuous assignments. Instance insertion is immediately before that module's `endmodule`, preserving blank-line convention. Use normalized model spans and source-order structural arrays, never keyword regex scanning.

- [ ] **Step 4: Verify style preservation**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/sourcePatch.test.js`

Expected: LF, CRLF, tab/four-space, empty module, comments before `endmodule`, and no-final-newline tests pass.

- [ ] **Step 5: Commit source style helpers**

```bash
git add veriflow-vscode/src/schematic/sourceStyle.ts veriflow-vscode/src/test/sourcePatch.test.ts
git commit -m "feat: preserve HDL source style"
```

### Task 3: Existing Named Instance Edits And New Instance Formatting

**Files:**
- Create: `veriflow-vscode/src/schematic/instancePatchPlanner.ts`
- Create: `veriflow-vscode/src/schematic/planDelta.ts`
- Create: `veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts`
- Create: `veriflow-vscode/src/test/instancePatchPlanner.test.ts`

- [ ] **Step 1: Write failing narrow-edit and new-instance golden tests**

```typescript
const context = await contextFor('named-instance.sv', journal([
  renameInstance('u_old', 'u_new'),
  reconnect('u_old', 'data_i', 'next_data'),
  setParameter('u_old', 'WIDTH', '16'),
]));
const plan = planInstanceChanges(context);
assert.deepStrictEqual(plan.map(edit => [edit.operation, edit.expectedText, edit.replacementText]), [
  ['renameInstance', 'u_old', 'u_new'],
  ['replaceParameter', '8', '16'],
  ['replaceConnection', 'source', 'next_data'],
]);
assert.strictEqual(renderNewInstance(newChild.node, newChild.definition, newChild.style), [
  'child #(', '    .WIDTH ( 16 ))', 'u_child (',
  '    .clk    ( clk       ),', '    .data_i (           ),', '    .data_o ( data_o    ));',
].join('\n'));
```

Create `src/test/helpers/sourcePlannerFixture.ts` with exact exports for `contextFor`, `journal`, `renameInstance`, `reconnect`, `setParameter`, and `newChild`. `contextFor(fixtureName, commands)` parses the named fixture through `parseWithRealWorker`, builds the base graph, replays the commands through a real `CommandJournal`, and returns a `PlannerContext` containing `canonicalizePlannerDelta(base, journal)`; command constructors return fully populated `GraphEditCommand` values with deterministic IDs.

Add history canonicalization goldens: rename the same source instance twice, set the same parameter twice, and reconnect the same named port twice; each must produce one edit from the base source text to the final value. Add then rename then delete a draft node and assert it produces no source edit. Undo with a non-empty redo suffix and assert only commands before `cursor` affect the plan.

- [ ] **Step 2: Run the planner test and verify it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/instancePatchPlanner.test.js`

Expected: FAIL because the instance planner is missing.

- [ ] **Step 3: Plan only confirmed narrow source spans**

```typescript
export type PlannerContext = {
  source: string; document: HdlDocument; module: ModuleModel;
  definitionFingerprints: Record<string, string>;
  baseGraph: EditableGraphState; currentGraph: EditableGraphState; delta: PlannerDelta;
};
export type GraphObjectDelta =
  | { kind: 'node'; objectId: string; before?: EditableNode; after?: EditableNode }
  | { kind: 'network'; objectId: string; before?: EditableNetwork; after?: EditableNetwork };
export type PlannerDelta = { activeCommands: readonly GraphEditCommand[]; objects: readonly GraphObjectDelta[] };
export function canonicalizePlannerDelta(base: EditableGraphState, journal: CommandJournal): PlannerDelta;
export type EndpointExpressionMap = Readonly<Record<string, string>>;
export function planInstanceChanges(context: PlannerContext, endpointExpressions: EndpointExpressionMap = {}): SourcePatchEdit[];
export function renderNewInstance(node: EditableNode, definition: HdlDefinitionSummary, style: SourceStyle): string;
```

`canonicalizePlannerDelta` reads only `journal.serialize().commands.slice(0, cursor)`, replays that prefix from `base`, and diffs stable node/network IDs between `base` and the replayed current state. Emit at most one before/after record per semantic object, ordered by kind then object ID. Objects absent in both states disappear, so add-rename-delete has no source effect; repeated rename/parameter/connection commands collapse to one final delta. Assert the replayed state equals `journal.current` before planning. Every specialized planner consumes `delta`, never one edit per journal command.

For named connections replace `expressionSpan` only. Resolve the final connection text from `endpointExpressions[`${instanceId}.${portName}`]` before falling back to the edited network name. For an implicit `.port`, first edit replaces its full connection span with `.port(new_expression)`. Replace existing parameter values and instance identifiers only at their semantic spans. Delete a safely mapped single instance declaration including one adjacent empty line. Return a blocking diagnostic for positional, wildcard, shared multi-instance punctuation, generate, array, macro, foreign/composite source spans, or unmapped syntax in this phase.

- [ ] **Step 4: Reuse the one shared instance formatter**

Build new-instance parameters from only states with `explicitOrigin: 'draft'`, in definition order. For existing instances, preserve states with `explicitOrigin: 'source'` even when their expression equals the current default. Build every named port in definition order, using an empty value for unconnected ports. Call `formatModuleInstantiation`; do not duplicate its alignment logic. Insert one merged block immediately before the selected module's `endmodule` using inferred indentation and line ending.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/instancePatchPlanner.test.js && node ./out/test/core.test.js`

Expected: narrow edits, implicit expansion, deletion, insertion order, empty `.port()`, explicit-override-only, CRLF, and existing formatter golden tests pass.

- [ ] **Step 5: Commit instance patch planning**

```bash
git add veriflow-vscode/src/schematic/planDelta.ts veriflow-vscode/src/schematic/instancePatchPlanner.ts veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts veriflow-vscode/src/test/instancePatchPlanner.test.ts
git commit -m "feat: plan schematic instance source edits"
```

### Task 4: ANSI And Non-ANSI Port Source Edits

**Files:**
- Create: `veriflow-vscode/src/schematic/portPatchPlanner.ts`
- Modify: `veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts`
- Create: `veriflow-vscode/src/test/portPatchPlanner.test.ts`

- [ ] **Step 1: Write failing ANSI/non-ANSI golden tests**

```typescript
assert.strictEqual(await applyFixture('ansi-add-input.sv', addInput('enable')), [
  'module top (', '    input  logic clk,', '    input  logic enable,', '    output logic done', ');',
  'endmodule', '',
].join('\n'));
assert.strictEqual(await applyFixture('nonansi-add-output.v', addOutput('valid', '[3:0]')), [
  'module top (clk, valid);', '    input clk;', '    output [3:0] valid;', 'endmodule', '',
].join('\n'));
```

Add grouped deletion cases such as `input a, b, c` deleting `b`, first/last/only item, and a deleted top port with a known surviving reference warning. Add goldens for changing only `b` in ANSI `input logic [7:0] a, b`, changing only `b` in non-ANSI `input [7:0] a, b;`, scalar-to-vector insertion, and vector-to-scalar removal.

Add `applyFixture`, `addInput`, and `addOutput` to `sourcePlannerFixture.ts`. `applyFixture` awaits the real parsed context, runs `planPortChanges`, wraps its edits in a `SourcePatchPlan`, and returns `applySourcePatchPlan(...).text`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/portPatchPlanner.test.js`

Expected: FAIL because port patch planning is absent.

- [ ] **Step 3: Implement declaration-style-specific edits**

```typescript
export type PortPatchResult = { edits: SourcePatchEdit[]; diagnostics: SchematicDiagnostic[] };
export function planPortChanges(context: PlannerContext, endpointExpressions: EndpointExpressionMap = {}): PortPatchResult;
```

For ANSI modules insert new input after the last input and new output after the last output without reordering existing items. For non-ANSI modules add the name in the header list and a body declaration in matching direction order. Delete only the target item and necessary delimiter/whitespace; when one name leaves a grouped declaration, preserve the declaration type/range and other names. Rename both header/body occurrences only when symbol resolution maps them to the same top-level port.

For an existing direction/width edit, use the port declaration-group metadata. Replace individual direction/range spans only when the target owns those tokens. If it inherits shared syntax, rewrite the smallest complete group: split the target into an explicit ANSI header item or a separate non-ANSI body declaration, while explicitly retaining the old prefix on every unaffected member. Scalar-to-vector inserts a packed range at the owned/shared prefix anchor; vector-to-scalar removes the range only after splitting other inheriting members. Changing existing `inout` to input/output is allowed, while no command can change input/output to `inout`.

- [ ] **Step 4: Plan boundary assignments**

For a new input connected to a differently named existing network emit `assign signal_name = input_port_name;`. For a new output emit `assign output_port_name = signal_name;`, taking `signal_name` or an inline constant/expression from `endpointExpressions[portId]`. Omit the assignment when a new network directly uses the port name. Added ports never use `inout`; deleted-port known references produce warnings, not blockers.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/portPatchPlanner.test.js`

Expected: ANSI/non-ANSI insertion, grouped deletion, rename, boundary assignment, line-ending, comment, and warning tests pass.

- [ ] **Step 5: Commit port planning**

```bash
git add veriflow-vscode/src/schematic/portPatchPlanner.ts veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts veriflow-vscode/src/test/portPatchPlanner.test.ts
git commit -m "feat: plan schematic port source edits"
```

### Task 5: Nets, Assignments, Materialization, And Scoped Rename

**Files:**
- Create: `veriflow-vscode/src/schematic/networkPatchPlanner.ts`
- Create: `veriflow-vscode/src/schematic/connectionSourcePlanner.ts`
- Modify: `veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts`
- Create: `veriflow-vscode/src/test/networkPatchPlanner.test.ts`

- [ ] **Step 1: Write failing network source tests**

```typescript
const context = await networkEditContext('network-edits.sv');
const result = planNetworkChanges(context);
const candidate = applySourcePatchPlan(context.source, {
  fileUri: context.document.uri, baseVersion: context.document.version,
  baseHash: context.document.textHash,
  preprocessingFingerprint: context.document.preprocessingFingerprint,
  definitionFingerprints: context.definitionFingerprints,
  edits: result.edits,
}).text;
assert.ok(candidate.includes('wire [7:0] payload;'));
assert.ok(candidate.includes('wire combined;'));
assert.ok(candidate.includes('assign combined = a & b;'));
const renames = result.edits.filter(edit => edit.operation === 'renameNetwork');
assert.deepStrictEqual(renames.map(edit => context.source.slice(edit.span.start, edit.span.end)), [
  'existing', 'existing', 'existing',
]);

const constants = await constantEditContexts();
assert.strictEqual(planConnectionSources(constants.singleInstanceLoad).endpointExpressions['u_child.enable'], "1'b1");
assert.ok(planConnectionSources(constants.topOutputLoad).edits.some(edit =>
  edit.replacementText.includes("assign done = 1'b1;")));
const shared = planConnectionSources(constants.twoLoads);
assert.strictEqual(shared.endpointExpressions['u_a.enable'], 'enable_const');
assert.strictEqual(shared.endpointExpressions['u_b.enable'], 'enable_const');
assert.ok(shared.edits.some(edit => edit.replacementText.includes('wire enable_const;')));
assert.ok(shared.edits.some(edit => edit.replacementText.includes("assign enable_const = 1'b1;")));
assert.strictEqual(planConnectionSources(constants.afterSetConstant).endpointExpressions['u_child.enable'], "1'b0");
```

Add `networkEditContext` and `constantEditContexts` to `sourcePlannerFixture.ts`. The first starts from a real parsed/base graph and uses the real `GraphEditCommand` union plus `CommandJournal` to create an 8-bit `payload` network, branch an existing expression so it materializes as `combined`, and rename the existing source network to `renamed`. The constant contexts use real `addConstant`, `setConstant`, `connect`, and `branch` commands for one instance load, one top-output load, and two instance loads; helpers never invent source-planner-only command kinds.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/networkPatchPlanner.test.js`

Expected: FAIL because network planning is missing.

- [ ] **Step 3: Insert normalized net and assignment source**

```typescript
export type NetworkPatchResult = {
  edits: SourcePatchEdit[]; diagnostics: SchematicDiagnostic[];
};
export function planNetworkChanges(context: PlannerContext, endpointExpressions: EndpointExpressionMap = {}): NetworkPatchResult;
export type ConnectionSourcePlan = {
  endpointExpressions: Record<string, string>;
  edits: SourcePatchEdit[];
  diagnostics: SchematicDiagnostic[];
};
export function planConnectionSources(context: PlannerContext): ConnectionSourcePlan;
```

Emit `wire name;` for one-bit known networks and `wire [N-1:0] name;` for known widths above one. Preserve a valid symbolic packed range; use scalar plus warning for unknown only when direct generation is allowed. Materialize a constant/expression when it has multiple loads, an explicit network name, a required shared source-width boundary, or an original net. Emit one `assign wire_name = expression;`. Use the passed `endpointExpressions` for final load expressions and do not independently materialize a source already planned by `planConnectionSources`.

When disconnect/delete removes the last use, delete a net declaration or continuous assignment only if its object origin is `draft` and it was created by the current journal. Never remove an existing source declaration or assignment as automatic cleanup; report an unused-existing-wire warning instead.

Keep a constant/read-only expression inline when it has one load. For an instance input, place its current text in `endpointExpressions` so the instance planner writes it into that named connection. For a top-level output, emit `assign output_port = expression;`. Materialize only for multiple loads, an explicit network name, a shared width-adaptation boundary, or an existing named net; emit one wire/assign and use that wire for every load. `setConstant` changes the current inline or materialized right-hand expression without changing these rules.

- [ ] **Step 4: Rename only resolved module-scope symbol references**

Use semantic reference spans collected by the normalized model. Rename its declaration, continuous assignments, and instance connection expressions that resolve exactly to the same symbol. Do not touch comments, strings, structure members, local variables, generate-local symbols, other modules, or unresolved macro text. Emit `SCHEMATIC_POSSIBLE_MACRO_REFERENCE` warnings for opaque macro spans.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/networkPatchPlanner.test.js`

Expected: declaration/assign insertion, materialization, collision, scoped rename, comments, strings, local scopes, and macro warning tests pass.

- [ ] **Step 5: Commit network planning**

```bash
git add veriflow-vscode/src/schematic/networkPatchPlanner.ts veriflow-vscode/src/schematic/connectionSourcePlanner.ts veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts veriflow-vscode/src/test/networkPatchPlanner.test.ts
git commit -m "feat: plan schematic network source edits"
```

### Task 6: File-Level Candidate Planning And Parse Validation

**Files:**
- Create: `veriflow-vscode/src/schematic/sourcePlanner.ts`
- Create: `veriflow-vscode/src/schematic/candidateValidator.ts`
- Create: `veriflow-vscode/src/test/sourceRoundTrip.test.ts`

- [ ] **Step 1: Write failing multi-module candidate tests**

```typescript
const candidate = await planner.plan(sessionWithChangesIn('first', 'second'));
assert.ok(candidate.text.includes('u_first_new'));
assert.ok(candidate.text.includes('u_second_new'));
const sorted = [...candidate.plan.edits].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
assert.ok(sorted.every((edit, index) => index === 0 || sorted[index - 1].span.end <= edit.span.start));
assert.strictEqual(candidate.diagnostics.filter(item => item.blocking).length, 0);
assert.strictEqual(candidate.baseVersion, 7);
```

Add `sessionWithChangesIn(...moduleNames)` to `sourcePlannerFixture.ts`; it returns a real `SchematicSession` whose named module journals each contain one staged instance rename.

Add a source with one pre-existing syntax error outside the edited region and assert the unchanged baseline error is allowed; insert text before that error and assert its shifted candidate span still matches the baseline; add a candidate-introduced error in a touched module and assert planning is rejected. Add an unchanged syntax error in an included header and assert a primary-file insertion does not shift or duplicate its foreign URI/span. Add a composite diagnostic with one primary and one included part and assert only the primary part is shifted; an edit intersecting that primary part makes the mapping undefined and forces conservative candidate revalidation.

- [ ] **Step 2: Run the round-trip test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/sourceRoundTrip.test.js`

Expected: FAIL because file-level planning and candidate validation are missing.

- [ ] **Step 3: Merge all modified module planners**

```typescript
export type SourceCandidate = {
  candidateId: string; fileUri: string; baseVersion: number; baseHash: string;
  preprocessingFingerprint: string; definitionFingerprints: Record<string, string>;
  text: string; plan: SourcePatchPlan; diagnostics: SchematicDiagnostic[];
};
export class SchematicSourcePlanner {
  constructor(private readonly parser: HdlParserClient, private readonly index: WorkspaceHdlIndex);
  plan(session: SchematicSession): Promise<SourceCandidate>;
}
export function mapBaselineSpanToCandidate(span: SourceSpan, edits: readonly SourcePatchEdit[], fileUri: string): SourceSpan | undefined;
```

Verify session status, the complete `SchematicSemanticBaseline`, and all module diagnostics first. Re-resolve every bound external definition and require its current `modelFingerprint` to equal the baseline before rendering. For every dirty module, compute the canonical `PlannerDelta`, then call `planConnectionSources(context)` before the other planners. Pass its exact `endpointExpressions` object to `planInstanceChanges`, `planPortChanges`, and `planNetworkChanges`; merge `connectionSources.edits` and diagnostics exactly once with those planner results. This guarantees an inline constant or materialized source expression reaches the final named instance connection, top-port boundary, and load-local network expression before any source edit is rendered. Merge same-anchor insertions in declaration/assignment/instance order, validate all spans/URI ownership/old text, build the candidate in memory, and compute `candidateId` from the source hash, preprocessing fingerprint, sorted definition fingerprints, and candidate content hash.

Add a file-level regression containing a single-load constant, a two-load materialized constant, a new output port, and an ordinary renamed network. Assert the candidate uses the `endpointExpressions` returned by the first planning pass, emits each wire/assign once, and has no overlapping edit at a shared insertion anchor.

- [ ] **Step 4: Reparse and compare syntax diagnostics**

Parse the current source and candidate with identical defines/include texts but different cache policy: the current document uses `cacheMode: 'document'`, while the candidate uses `cacheMode: 'ephemeral'`. The candidate text hash must differ from or be independently checked against the baseline even when URI/version are identical. For a contiguous span owned by `fileUri` (or with omitted URI), `mapBaselineSpanToCandidate` returns `undefined` when it intersects an edit and otherwise shifts both offsets by the cumulative replacement-length delta of preceding edits. A contiguous foreign-URI span is returned unchanged. For `compositeParts`, map each primary-file part, keep every foreign part unchanged, return `undefined` if any primary part intersects an edit, and rebuild the ordered parts. Compare candidate errors to baseline by code/message signature plus owning URI and the complete mapped span/parts, so a primary insertion does not turn an unchanged include error into a false new error. Reject any genuinely new candidate syntax error or worsened baseline error intersecting an edited module. Return warnings for symbolic width, deleted references, unused existing nets, automatic future adapters, and opaque macro references.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/sourceRoundTrip.test.js`

Expected: multi-module merge, overlap rejection, stale old text, baseline error, new error, and byte-identical untouched-slice tests pass.

- [ ] **Step 5: Commit candidate planning**

```bash
git add veriflow-vscode/src/schematic/sourcePlanner.ts veriflow-vscode/src/schematic/candidateValidator.ts veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts veriflow-vscode/src/test/sourceRoundTrip.test.ts
git commit -m "feat: validate schematic source candidates"
```

### Task 7: Native Diff Preview And Atomic Application

**Files:**
- Create: `veriflow-vscode/src/schematic/diffPreviewProvider.ts`
- Create: `veriflow-vscode/src/schematic/sourceApplication.ts`
- Modify: `veriflow-vscode/src/schematic/schematicSession.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts`
- Modify: `veriflow-vscode/src/test/sourceRoundTrip.test.ts`
- Modify: `veriflow-vscode/package.json`

- [ ] **Step 1: Write failing preview identity and atomic-apply tests**

```typescript
const harness = createSourceRoundTripHarness();
const preview = await harness.generate();
assert.strictEqual(harness.diff.left.toString(), 'file:///top.sv');
assert.strictEqual(harness.diff.right.scheme, 'veriflow-candidate');
assert.strictEqual(harness.virtualDocuments.provide(preview.rightUri), preview.text);
await harness.apply(preview.candidateId);
assert.strictEqual(harness.workspaceEdits.length, 1);
assert.strictEqual(harness.workspaceEdits[0].replacements.length, 1);
assert.strictEqual(harness.workspaceEdits[0].replacements[0].text, preview.text);
```

Change the document version after preview and assert apply returns `SOURCE_CHANGED` and submits no edit. Separately change only the include/preprocessing fingerprint and only a bound child `modelFingerprint`; assert both invalidate the preview, return `SEMANTIC_BASELINE_CHANGED`, and submit no edit.

Add this exact Node-only harness export to `sourcePlannerFixture.ts`; it exercises injected host ports so the CommonJS unit test never loads the runtime `vscode` module:

```typescript
export type UriLike = { scheme: string; toString(): string };
export type RecordedWorkspaceEdit = {
  replacements: Array<{ uri: string; start: number; end: number; text: string }>;
};
export type SourceRoundTripHarness = {
  generate(): Promise<SourceCandidate & { rightUri: UriLike }>;
  apply(candidateId: string): Promise<void>;
  document: { uri: UriLike; version: number; text: string };
  diff: { left: UriLike; right: UriLike };
  virtualDocuments: { provide(uri: UriLike): string | undefined };
  workspaceEdits: RecordedWorkspaceEdit[];
};
export function createSourceRoundTripHarness(): SourceRoundTripHarness;
```

The harness URI implementation exposes `scheme`, `toString()`, and stable equality text. Construct the harness with a real `SchematicSourcePlanner`, an in-memory candidate document store, an injected `openDiff(left, right)` recorder, and an injected `applyWorkspaceEdit(edit)` recorder. The production `DiffPreviewProvider` and `applyCandidate` remain thin VS Code adapters over those pure store/application seams; their actual `vscode.diff`, invalidation, atomic edit, and Undo behavior is covered by the Extension Host acceptance task in phase 6.

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/sourceRoundTrip.test.js`

Expected: FAIL because preview and application services are absent.

- [ ] **Step 3: Publish immutable virtual candidate documents**

```typescript
export class DiffPreviewProvider implements vscode.TextDocumentContentProvider {
  readonly onDidChange: vscode.Event<vscode.Uri>;
  publish(candidate: SourceCandidate): vscode.Uri;
  provideTextDocumentContent(uri: vscode.Uri): string | undefined;
  discard(candidateId: string): void;
  invalidateFile(fileUri: string): void;
}
```

Use `veriflow-candidate` URIs containing encoded file URI and candidate ID. `Generate Verilog` publishes the candidate then executes `vscode.diff` with current source left and candidate right. Keep Apply Changes and Discard Preview in the schematic toolbar; the diff editor itself stays native and read-only on the right.

- [ ] **Step 4: Apply one full-document WorkspaceEdit after second checks**

```typescript
export async function applyCandidate(
  document: vscode.TextDocument,
  candidate: SourceCandidate,
  readSemanticBaseline: () => Promise<SchematicSemanticBaseline>,
  apply: (edit: vscode.WorkspaceEdit) => PromiseLike<boolean>,
): Promise<void>;
```

Recheck URI, document version, current source hash, preprocessing fingerprint, every bound definition fingerprint, candidate ID, every old-text precondition, and candidate parse validity. Create one `WorkspaceEdit.replace(document.uri, fullDocumentRange, candidate.text)` and call `workspace.applyEdit` once. Any failed check throws before constructing an edit; a false apply result leaves the session/draft unchanged. An include, define configuration, or bound child-definition invalidation discards the preview even when the primary text document version/hash is unchanged.

- [ ] **Step 5: Refresh sessions after successful application**

After the document change event confirms the applied candidate hash, reparse, rematch graph identities, clear applied journals/undo stacks and persisted draft, discard the candidate, preserve layout, and broadcast refreshed graphs. An unrelated external change invalidates preview and marks the session conflicted rather than being mistaken for the expected apply.

- [ ] **Step 6: Verify and commit source round trip**

Run: `cd veriflow-vscode && npm test && npm run lint && npm run package`

Expected: candidate diff opens; warnings allow preview/apply; blockers disable Generate; stale preview applies nothing; one VS Code undo restores the full pre-apply document.

```bash
git add veriflow-vscode/src/schematic/diffPreviewProvider.ts veriflow-vscode/src/schematic/sourceApplication.ts veriflow-vscode/src/schematic/schematicSession.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/src/test/helpers/sourcePlannerFixture.ts veriflow-vscode/src/test/sourceRoundTrip.test.ts veriflow-vscode/package.json
git commit -m "feat: round-trip schematic edits through native diff"
```

## Plan Completion Gate

Run from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run package
```

Expected results:

- all supported staged changes from every dirty module appear in one candidate document;
- existing named edits are narrow, new instances use the shared aligned formatter before the correct `endmodule`, and ANSI/non-ANSI ports preserve declaration style;
- new nets/assignments use correct anchors, boundary assignments follow confirmed direction, and unrelated source remains byte-identical;
- candidate parsing adds no syntax errors, failed preconditions apply nothing, and stale source invalidates preview;
- native Diff Editor shows the complete candidate before one atomic `WorkspaceEdit` and one VS Code undo reverts it;
- successful apply clears only applied graph drafts/undo and retains layout state.

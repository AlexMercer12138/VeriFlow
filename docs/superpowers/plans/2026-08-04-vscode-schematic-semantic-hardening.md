# VS Code Schematic Semantic Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete schematic semantics for parameterized widths, automatic adapters, legacy instance syntax, generate/array structures, opaque logic, diagnostics, and production-scale recovery/performance.

**Architecture:** Extend the normalized model with a serializable expression tree and elaboration metadata, then keep evaluation, endpoint semantics, and source rendering in separate pure modules. Unsupported or ambiguous structures stay visible and source-preserving; only uniquely mapped shared templates become editable, and every automatic transformation is represented in both graph diagnostics and the source candidate.

**Tech Stack:** TypeScript 5, Tree-sitter SystemVerilog CST adapter, normalized HDL/index models, AntV X6, Playwright Chromium, @vscode/test-electron, Node assert benchmarks/tests, VSCE

---

## Prerequisite

Complete source round trip first. This phase removes the last legacy `new Function` width evaluator and enables previously blocked instance/generate cases only where source mapping is unambiguous.

## Test File Convention

Keep imports at top level, put every shown test body inside `async function main(): Promise<void>`, and end with `void main().catch(error => { console.error(error); process.exitCode = 1; });`. Do not use top-level `await` under the CommonJS `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/src/core/hdl/expressionAst.ts`: serializable expression AST contracts.
- Create `veriflow-vscode/src/core/hdl/constantEvaluator.ts`: bounded integer evaluation without JavaScript execution.
- Create `veriflow-vscode/src/core/hdl/fragmentParser.ts`: Tree-sitter-backed user expression and packed-range parsing.
- Create `veriflow-vscode/src/schematic/widthResolver.ts`: parameter environments, packed ranges, and endpoint widths.
- Create `veriflow-vscode/src/schematic/widthAdapter.ts`: per-load extension/truncation planning and rendering.
- Create `veriflow-vscode/src/schematic/instanceNormalizer.ts`: positional, implicit, wildcard, and shared declaration conversion.
- Create `veriflow-vscode/src/schematic/elaborationModel.ts`: generate and instance-array presentation/editability.
- Create `veriflow-vscode/src/schematic/diagnosticPresenter.ts`: Problems, canvas, inspector, Output, and status summaries.
- Create `veriflow-vscode/src/test/hdlExpressionEvaluator.test.ts`: operator, parameter, conditional, and `$clog2` tests.
- Create `veriflow-vscode/src/test/schematicWidth.test.ts`: known/symbolic/unknown and range-aware adapter tests.
- Create `veriflow-vscode/src/test/instanceNormalizer.test.ts`: positional/wildcard/implicit conversion goldens.
- Create `veriflow-vscode/src/test/schematicElaboration.test.ts`: generate/array read-only/shared-template tests.
- Create `veriflow-vscode/src/test/schematicDiagnostics.test.ts`: blocking/warning presentation tests.
- Create `veriflow-vscode/src/test/schematicPerformance.test.ts`: indexing, graph, worker memory, and cancellation budgets.
- Create `veriflow-vscode/src/test/helpers/schematicBenchmark.ts`: deterministic workspace generation and benchmark API.
- Create `veriflow-vscode/webview/schematic/tests/schematic.spec.ts`: real Chromium canvas interaction and large-graph tests.
- Create `veriflow-vscode/webview/schematic/test-harness.html`: mocked VS Code API host for browser tests.
- Create `veriflow-vscode/playwright.config.mjs`: pinned Chromium test configuration.
- Create `veriflow-vscode/scripts/serve-schematic-test.mjs`: local static harness server.
- Create `veriflow-vscode/scripts/assert-package-contents.mjs`: structured VSIX file allow/deny assertions.
- Create `veriflow-vscode/src/test/runExtensionTests.ts`: `@vscode/test-electron` launcher.
- Create `veriflow-vscode/src/test/suite/index.ts`: Extension Host acceptance entry point.
- Create `veriflow-vscode/src/test/suite/schematicExtensionHost.test.ts`: native custom editor, diff, diagnostics, apply, and Undo acceptance.
- Create `.github/workflows/vscode-schematic-ci.yml`: Node 20 cross-platform, browser, package, and VS Code version matrix.
- Create `veriflow-vscode/src/test/helpers/hdlExpressionFixture.ts`: real-parser expression and packed-range fixtures.
- Create `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`: width, instance, elaboration, and diagnostic fixtures.
- Modify `veriflow-vscode/src/core/hdl/model.ts`: AST, symbol references, packed range, generate, and array metadata.
- Modify `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`: CST-to-AST, references, and elaboration extraction.
- Modify `veriflow-vscode/src/core/testbenchGenerator.ts`: use the safe evaluator.
- Modify `veriflow-vscode/src/schematic/graphBuilder.ts`: elaborated/read-only nodes and width annotations.
- Modify `veriflow-vscode/src/schematic/graphValidator.ts`: width and elaboration diagnostics.
- Modify `veriflow-vscode/src/schematic/instancePatchPlanner.ts`: normalize supported existing syntax.
- Modify `veriflow-vscode/src/schematic/networkPatchPlanner.ts`: insert adapter expressions and materialization.
- Modify `veriflow-vscode/src/schematic/schematicEditorProvider.ts`: publish complete diagnostics and recovery commands.
- Modify `veriflow-vscode/src/core/hdl/protocol.ts`: worker graph-build requests/responses.
- Modify `veriflow-vscode/src/core/hdl/parserWorker.ts`: build large graphs off the extension-host event loop.
- Modify `veriflow-vscode/src/core/hdl/parserClient.ts`: graph-build request API.
- Modify `veriflow-vscode/src/schematic/protocol.ts`: chunked graph-transfer events.
- Modify `veriflow-vscode/webview/schematic/index.ts`: adapter labels, collapsed arrays, and diagnostic navigation.
- Modify `veriflow-vscode/package.json`: complete test and benchmark scripts.
- Modify `veriflow-vscode/.vscodeignore`: exclude browser/Extension Host test sources and benchmark helpers from VSIX.

### Task 1: Serializable Expression AST And Safe Constant Evaluation

**Files:**
- Create: `veriflow-vscode/src/core/hdl/expressionAst.ts`
- Create: `veriflow-vscode/src/core/hdl/constantEvaluator.ts`
- Create: `veriflow-vscode/src/core/hdl/fragmentParser.ts`
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Modify: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`
- Modify: `veriflow-vscode/src/schematic/editModel.ts`
- Modify: `veriflow-vscode/src/schematic/commandReducer.ts`
- Modify: `veriflow-vscode/src/schematic/draftStore.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/instancePatchPlanner.ts`
- Modify: `veriflow-vscode/src/schematic/portPatchPlanner.ts`
- Modify: `veriflow-vscode/src/schematic/connectionSourcePlanner.ts`
- Modify: `veriflow-vscode/src/schematic/networkPatchPlanner.ts`
- Modify: `veriflow-vscode/src/schematic/sourcePlanner.ts`
- Create: `veriflow-vscode/src/test/helpers/hdlExpressionFixture.ts`
- Create: `veriflow-vscode/src/test/hdlExpressionEvaluator.test.ts`

- [ ] **Step 1: Write failing evaluator tests**

```typescript
import * as assert from 'assert';
import { evaluateConstantExpression } from '../core/hdl/constantEvaluator';
import { parseExpressionFixture } from './helpers/hdlExpressionFixture';

const env = new Map([['WIDTH', 8n], ['DEPTH', 17n]]);
assert.deepStrictEqual(evaluateConstantExpression(await parseExpressionFixture('WIDTH * 2 + 1'), env), { kind: 'known', value: 17n });
assert.deepStrictEqual(evaluateConstantExpression(await parseExpressionFixture('$clog2(DEPTH)'), env), { kind: 'known', value: 5n });
assert.deepStrictEqual(evaluateConstantExpression(await parseExpressionFixture('WIDTH > 4 ? WIDTH : 4'), env), { kind: 'known', value: 8n });
assert.strictEqual(evaluateConstantExpression(await parseExpressionFixture('UNKNOWN + 1'), env).kind, 'symbolic');
assert.strictEqual(evaluateConstantExpression(await parseExpressionFixture('1 / 0'), env).kind, 'unknown');
```

Create `src/test/helpers/hdlExpressionFixture.ts`. Its `parseExpressionFixture(expression)` parses ``module expression_fixture; localparam VALUE = ${expression}; endmodule`` through `parseWithRealWorker` and returns the `ExpressionModel` stored on `VALUE`; it never implements a second expression parser.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlExpressionEvaluator.test.js`

Expected: FAIL because the normalized AST and evaluator are absent.

- [ ] **Step 3: Define a bounded normalized expression tree**

```typescript
export type ExpressionAst =
  | { kind: 'integer'; text: string; value?: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'unary'; operator: '+' | '-' | '!' | '~'; operand: ExpressionAst }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '%' | '**' | '<<' | '>>' | '&' | '|' | '^' | '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>='; left: ExpressionAst; right: ExpressionAst }
  | { kind: 'conditional'; condition: ExpressionAst; whenTrue: ExpressionAst; whenFalse: ExpressionAst }
  | { kind: 'call'; name: '$clog2'; arguments: ExpressionAst[] }
  | { kind: 'unsupported'; text: string };
export type ConstantEvaluation =
  | { kind: 'known'; value: bigint }
  | { kind: 'symbolic'; expression: string; identifiers: string[] }
  | { kind: 'unknown'; reason: string };
export type DraftExpressionModel = {
  text: string; ast: ExpressionAst; diagnostics: HdlDiagnostic[];
};
export type DraftPackedRangeModel = {
  text: string; left: DraftExpressionModel; right: DraftExpressionModel; diagnostics: HdlDiagnostic[];
};
```

Add `ast: ExpressionAst` to structural `ExpressionModel` values; add `defaultValue?: ExpressionModel` to `ParameterModel` and require source instance connections with expressions to carry `expressionModel`. The Tree-sitter adapter maps CST operators and parentheses exactly; it emits `unsupported` for casts, real/time/string values, unknown digits, or calls other than `$clog2` rather than guessing.

Implement fragment parsing by wrapping user input in synthetic HDL and calling the same `HdlParserClient` with `cacheMode: 'ephemeral'`:

```typescript
export class HdlFragmentParser {
  constructor(private readonly parser: HdlParserClient, private readonly preprocess: PreprocessOptions) {}
  parseExpression(text: string): Promise<DraftExpressionModel>;
  parsePackedRange(text: string): Promise<DraftPackedRangeModel>;
}
```

`parseExpression` parses `module __veriflow_fragment; localparam __VALUE = (<text>); endmodule`; `parsePackedRange` parses `module __veriflow_fragment; wire <text> __VALUE; endmodule`. Extract only the normalized AST/range, strip synthetic source spans, and return parser diagnostics adjusted to the user fragment. Empty/malformed fragments return structured diagnostics and never enter a graph command.

Change draft-edit payloads to carry parsed values:

```typescript
// Semantic-phase replacements inside GraphEditCommand
{ type: 'setParameter'; instanceId: string; parameterName: string; expression?: DraftExpressionModel }
{ type: 'addConstant'; nodeId: string; expression: DraftExpressionModel }
{ type: 'setConstant'; nodeId: string; expression: DraftExpressionModel }
{ type: 'addPort'; portId: string; name: string; direction: 'input' | 'output'; packedRange?: DraftPackedRangeModel }
{ type: 'setPort'; portId: string; direction: 'input' | 'output' | 'inout'; packedRange?: DraftPackedRangeModel }
```

The provider parses palette/inspector text before dispatching these commands and returns field diagnostics on failure. Bump the draft schema to 2; on a matching complete semantic baseline, migrate schema-1 raw expression/range strings through `HdlFragmentParser` before journal replay, and leave the draft conflicted if any fragment cannot be parsed. In the same commit, update all phase-5 instance/port/connection/network/source planners to render parsed values exclusively through `.text`; their source output stays unchanged while the graph state gains AST data. Extend `instancePatchPlanner.test.ts`, `portPatchPlanner.test.ts`, and `networkPatchPlanner.test.ts` with parsed payloads and the existing exact source goldens, then run `npm run compile:ts` before committing so no intermediate planner still expects a string payload.

- [ ] **Step 4: Implement evaluation without `eval` or `Function`**

```typescript
export function evaluateConstantExpression(
  expression: ExpressionModel | ExpressionAst,
  environment: ReadonlyMap<string, bigint>,
  limits: { maxDepth: number; maxExponent: number } = { maxDepth: 64, maxExponent: 1024 },
): ConstantEvaluation;
```

Parse sized/unsized binary, octal, decimal, and hexadecimal integers into `bigint`; reject X/Z digits. Implement the listed unary/binary/conditional operators and integer `$clog2`. Return symbolic with sorted unresolved identifiers when the AST is valid but parameters are absent. Return unknown for division by zero, negative/oversized exponent, depth limit, unsupported node, or result outside signed 4096-bit magnitude.

- [ ] **Step 5: Replace the Testbench evaluator and verify no dynamic code execution remains**

Add `widthValue?: WidthValue` and `packedRangeModel?: PackedRangeModel` to the temporary compatibility `Port` type and populate them in `legacyModelAdapter`. Parse Testbench parameter overrides through `HdlFragmentParser` in `TestbenchPanelProvider`, store `DraftExpressionModel` values in `TbModuleConfig`, and use those normalized expressions plus the same evaluator for port width resolution. Delete `replaceClog2`, `evalExpr`, and `new Function` from `testbenchGenerator.ts`; do not parse the compatibility width string.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlExpressionEvaluator.test.js && node ./out/test/core.test.js && rg -n "eval\(|new Function|Function\(" src`

Expected: evaluator and Testbench tests pass; the search returns no dynamic JavaScript evaluation in `src`.

- [ ] **Step 6: Commit safe expression evaluation**

```bash
git add veriflow-vscode/src/core/hdl/expressionAst.ts veriflow-vscode/src/core/hdl/constantEvaluator.ts veriflow-vscode/src/core/hdl/fragmentParser.ts veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/core/types.ts veriflow-vscode/src/core/hdl/legacyModelAdapter.ts veriflow-vscode/src/core/testbenchGenerator.ts veriflow-vscode/src/testbenchPanel.ts veriflow-vscode/src/schematic/editModel.ts veriflow-vscode/src/schematic/commandReducer.ts veriflow-vscode/src/schematic/draftStore.ts veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/schematic/instancePatchPlanner.ts veriflow-vscode/src/schematic/portPatchPlanner.ts veriflow-vscode/src/schematic/connectionSourcePlanner.ts veriflow-vscode/src/schematic/networkPatchPlanner.ts veriflow-vscode/src/schematic/sourcePlanner.ts veriflow-vscode/src/test/helpers/hdlExpressionFixture.ts veriflow-vscode/src/test/hdlExpressionEvaluator.test.ts veriflow-vscode/src/test/core.test.ts
git commit -m "feat: evaluate HDL constants without JavaScript eval"
```

### Task 2: Parameter Environments And Exact Packed Ranges

**Files:**
- Create: `veriflow-vscode/src/schematic/widthResolver.ts`
- Modify: `veriflow-vscode/src/schematic/schematicSession.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/commandReducer.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Create: `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`
- Modify: `veriflow-vscode/src/test/helpers/hdlExpressionFixture.ts`
- Create: `veriflow-vscode/src/test/schematicWidth.test.ts`
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Modify: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`

- [ ] **Step 1: Write failing width-resolution tests**

```typescript
const definition = await childDefinition({ WIDTH: '8', EXTRA: '2' }, '[WIDTH+EXTRA-1:0]');
assert.deepStrictEqual(resolveInstanceWidths(definition, { WIDTH: await draftExpressionFixture('12') }).ports.data, {
  width: { kind: 'known', bits: 14 }, range: { left: 13, right: 0, direction: 'descending' },
});
assert.strictEqual(resolveInstanceWidths(definition, { WIDTH: await draftExpressionFixture('P') }).ports.data.width.kind, 'symbolic');
assert.deepStrictEqual(resolvePackedRange(await packedRangeFixture('[15:8]'), emptyEnvironment), {
  width: { kind: 'known', bits: 8 }, range: { left: 15, right: 8, direction: 'descending' },
});
```

- [ ] **Step 2: Run the width test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicWidth.test.js`

Expected: FAIL because width resolution is missing.

- [ ] **Step 3: Preserve packed range AST and declared index direction**

```typescript
export type PackedRangeModel = {
  text: string; left: ExpressionModel; right: ExpressionModel;
};
export type ResolvedPackedRange = {
  width: WidthValue;
  range?: { left: number; right: number; direction: 'ascending' | 'descending' };
};
export type ResolvedInstanceWidths = {
  parameters: Record<string, ConstantEvaluation>;
  ports: Record<string, ResolvedPackedRange>;
  diagnostics: SchematicDiagnostic[];
};
```

Replace string-only range parsing with left/right CST expression nodes in ports and nets. Preserve original text for display/source reuse.

- [ ] **Step 4: Resolve parameters in declaration order**

```typescript
export function buildParameterEnvironment(
  definition: ModuleModel,
  overrides: Readonly<Record<string, DraftExpressionModel>>,
): { values: Map<string, bigint>; resolved: Record<string, ConstantEvaluation>; diagnostics: SchematicDiagnostic[] };
export function resolvePackedRange(range: PackedRangeModel | undefined, environment: ReadonlyMap<string, bigint>): ResolvedPackedRange;
export function resolveInstanceWidths(definition: ModuleModel, overrides: Readonly<Record<string, DraftExpressionModel>>): ResolvedInstanceWidths;
```

Add `packedRangeFixture(text)` and `draftExpressionFixture(text)` to `hdlExpressionFixture.ts`; both use `HdlFragmentParser`, and the former returns the real adapter-produced `PackedRangeModel`. Create `schematicSemanticFixture.ts` with `childDefinition`, `emptyEnvironment`, and the endpoint constructors used by width tests; every definition is a complete `ModuleModel`.

Define `MAX_SCHEMATIC_BITS = 1_048_576`. Evaluate each parameter's normalized `defaultValue.ast` and every override's already parsed AST in declaration order, retaining explicit override text. Keep range endpoints as `bigint` until validation. Convert each endpoint to `number` only when it is a safe integer; a known range width is `abs(left-right)+1`, must be positive, and must not exceed `MAX_SCHEMATIC_BITS`. Out-of-safe-integer endpoints or over-limit widths return `{ kind: 'unknown' }` plus `HDL_WIDTH_OUT_OF_RANGE`; never round, clamp, produce `Infinity`, or pass an unsafe number to adapter rendering. Negative but safe declared indices are valid and preserve their direction.

`SchematicSession` maintains a non-persisted full-model cache with this testable surface:

```typescript
export type DefinitionModelResolver = (definitionKey: string) => Promise<ModuleModel>;
export class SchematicSession {
  resolveDefinitionModel(definitionKey: string): Promise<ModuleModel>;
  invalidateDefinitionModel(definitionKey: string): void;
}
```

Construct the resolver from `WorkspaceHdlIndex.resolveDefinition`, require the exact module result, and cache `Map<definitionKey, { fingerprint: string; model: ModuleModel }>` for every displayed/added/bound instance. Definition summaries remain in serializable graph/draft state, while width resolution always receives the exact full model. On `setParameter`, resolve/cache the model, reduce the command, recompute that instance's pins and every adjacent network/load adapter, then broadcast one updated graph. Index invalidation evicts a changed fingerprint and conflicts a dirty session as specified in phase 4. A missing/ambiguous full model remains a blocking binding diagnostic.

In `schematicWidth.test.ts`, instrument the resolver: opening two instances bound to the same definition calls it once; `setParameter` changes the target pin widths and adjacent adapters using the cached full model; `invalidateDefinitionModel` followed by a clean rebuild calls it again; a changed definition during a dirty session produces a conflict rather than silently recomputing against a new contract. Add range cases for `[-1:-8]` (known width 8), an endpoint at `2**53` (unknown), and a width above `MAX_SCHEMATIC_BITS` (unknown diagnostic).

- [ ] **Step 5: Verify and commit width resolution**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicWidth.test.js`

Expected: default/override chains, `$clog2`, ascending/descending/non-zero ranges, symbolic cycles, unknown ranges, and recomputation tests pass.

```bash
git add veriflow-vscode/src/schematic/widthResolver.ts veriflow-vscode/src/schematic/schematicSession.ts veriflow-vscode/src/schematic/graphBuilder.ts veriflow-vscode/src/schematic/commandReducer.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/test/helpers/hdlExpressionFixture.ts veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts veriflow-vscode/src/test/schematicWidth.test.ts
git commit -m "feat: resolve parameterized schematic widths"
```

### Task 3: Per-Load Width Adapters And Source Rendering

**Files:**
- Create: `veriflow-vscode/src/schematic/widthAdapter.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/graphValidator.ts`
- Modify: `veriflow-vscode/src/schematic/networkPatchPlanner.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`
- Modify: `veriflow-vscode/src/test/schematicWidth.test.ts`

- [ ] **Step 1: Write exact adapter expression tests**

```typescript
assert.deepStrictEqual(planWidthAdapter(knownSource(8, '[7:0]'), knownLoad(12)), {
  kind: 'zeroExtend', sourceBits: 8, loadBits: 12, expression: "{4'd0, src}", warning: true,
});
assert.deepStrictEqual(planWidthAdapter(knownSource(8, '[15:8]'), knownLoad(4)), {
  kind: 'truncate', sourceBits: 8, loadBits: 4, expression: 'src[11:8]', warning: true,
});
assert.deepStrictEqual(planWidthAdapter(knownSource(8, '[0:7]'), knownLoad(4)), {
  kind: 'truncate', sourceBits: 8, loadBits: 4, expression: 'src[4:7]', warning: true,
});
assert.strictEqual(planWidthAdapter(symbolicSource('SRC_WIDTH'), symbolicLoad('DST_WIDTH')).kind, 'directWarning');
assert.strictEqual(planWidthAdapter(
  symbolicSource('SRC_WIDTH'), provenWiderSymbolicLoad('DST_WIDTH', 'DST_WIDTH-SRC_WIDTH'),
).expression, "{{(DST_WIDTH-SRC_WIDTH){1'b0}}, src}");
assert.strictEqual(planWidthAdapter(unknownSource(), knownLoad(8)).kind, 'directWarning');
```

Add `knownSource`, `knownLoad`, `symbolicSource`, `symbolicLoad`, `provenWiderSymbolicLoad`, and `unknownSource` to `schematicSemanticFixture.ts`. Each returns a complete `ResolvedEndpoint` including the displayed signal name, packed range, direction, and resolved width.

- [ ] **Step 2: Run the width test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicWidth.test.js`

Expected: FAIL because adapter planning is absent.

- [ ] **Step 3: Implement unique-source network widths and load-local adapters**

```typescript
export type WidthAdapter =
  | { kind: 'none'; expression: string; warning: false }
  | { kind: 'zeroExtend' | 'truncate' | 'symbolicExtend'; sourceBits?: number; loadBits?: number; expression: string; warning: true }
  | { kind: 'directWarning'; expression: string; warning: true }
  | { kind: 'inoutMismatch'; expression: string; blocking: true };
export type WidthRelationEvidence = {
  kind: 'provenSourceNarrower'; sourceEndpointId: string;
  positiveDifferenceExpression: string;
  proof: 'normalized-positive-offset' | 'elaboration-constraint';
};
export type ResolvedEndpoint = {
  id: string;
  displayedName: string;
  direction: 'driver' | 'load' | 'bidirectional';
  packedRange?: ResolvedPackedRange;
  width: WidthValue;
  relationEvidence?: WidthRelationEvidence;
};
export function planWidthAdapter(source: ResolvedEndpoint, load: ResolvedEndpoint, signalName = 'src'): WidthAdapter;
```

The named network adopts its unique driver's width. For known narrow-to-wide, calculate `loadBits-sourceBits` in TypeScript and emit `{delta'd0, signal}`. For symbolic source/load expressions, emit `{{(DST-SRC){1'b0}}, signal}` only when the resolver attaches `WidthRelationEvidence` proving a positive source-to-load difference through normalized positive-offset algebra or an elaboration constraint; two independent symbolic identifiers have no proof and remain a direct connection with warning. For wide-to-narrow, select load-width indices from the declared right-hand (least-significant) bound, preserving ascending/descending range syntax. Never auto-adapt `inout`.

- [ ] **Step 4: Apply adapters per load and make them visible**

The network planner substitutes the adapter expression only at that load's connection/boundary assignment. X6 edge labels and the inspector show adapter kind and before/after width. Constants/expressions with multiple adapted loads materialize once at their source width, then each load adapts independently.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicWidth.test.js && node ./out/test/networkPatchPlanner.test.js`

Expected: numeric zero extension, parameterized extension, both range directions, scalar cases, direct warnings, materialized fan-out, and blocking `inout` mismatch tests pass.

- [ ] **Step 5: Commit adapter semantics**

```bash
git add veriflow-vscode/src/schematic/widthAdapter.ts veriflow-vscode/src/schematic/graphBuilder.ts veriflow-vscode/src/schematic/graphValidator.ts veriflow-vscode/src/schematic/networkPatchPlanner.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts veriflow-vscode/src/test/schematicWidth.test.ts veriflow-vscode/src/test/networkPatchPlanner.test.ts
git commit -m "feat: adapt schematic connection widths"
```

### Task 4: Positional, Implicit, Wildcard, And Shared Instance Syntax

**Files:**
- Create: `veriflow-vscode/src/schematic/instanceNormalizer.ts`
- Modify: `veriflow-vscode/src/schematic/instancePatchPlanner.ts`
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Modify: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`
- Modify: `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`
- Create: `veriflow-vscode/src/test/instanceNormalizer.test.ts`

- [ ] **Step 1: Write failing conversion goldens**

```typescript
const definition = await childDefinition();
const positional = await positionalFixture();
const containingModule = await containingModuleFixture();
assert.strictEqual(normalizeEditedInstance(positional, definition, containingModule), [
  'child #(', '    .WIDTH ( 8 ))', 'u_child (',
  '    .clk    ( clk    ),', '    .data_i ( source ),', '    .data_o ( sink   ));',
].join('\n'));
assert.strictEqual(normalizeEditedInstance(await wildcardFixture(), definition, containingModule), [
  'child u_child (', '    .clk    ( clk    ),', '    .data_i ( data_i ),', '    .data_o ( data_o ));',
].join('\n'));
assert.throws(() => normalizeEditedInstance(positional, undefined, containingModule), /definition is required/);
```

Add real-parser-derived `positionalFixture`, `wildcardFixture`, `childDefinition`, and `containingModuleFixture` objects to `schematicSemanticFixture.ts`; do not construct connection spans by hand. The wildcard fixture contains one same-name symbol, one explicit override, and one definition port absent from the containing module.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/instanceNormalizer.test.js`

Expected: FAIL because the normalizer is missing.

- [ ] **Step 3: Normalize against one exact bound definition**

```typescript
export type NormalizedInstanceConnections = {
  parameters: NamedConnection[]; ports: NamedConnection[]; reasons: string[];
};
export function resolveInstanceConnections(instance: InstanceModel, definition: ModuleModel, containingModule: ModuleModel): NormalizedInstanceConnections;
export function normalizeEditedInstance(instance: InstanceModel, definition: ModuleModel | undefined, containingModule: ModuleModel): string;
```

Map positional parameters/ports by definition order. Expand implicit `.port` to `.port(port)` in graph semantics. For `.*`, preserve every explicit connection first; for each remaining definition port, connect `.port(port)` only when `containingModule.symbols` has that exact visible module-scope name, otherwise emit `.port()` instead of inventing an undeclared identifier. Empty positions become empty named connections. On first supported edit, rewrite the complete safe declaration with `formatModuleInstantiation`.

- [ ] **Step 4: Handle shared declarations and failure modes**

Use `InstanceDeclarationGroupModel` from the normalized adapter for multiple instances sharing module/parameter syntax. Rewrite the complete `statementSpan` only when its shared module/parameter spans plus every instance item/separator span are unambiguous; otherwise keep all visible but read-only. Add real CST goldens for two instances with shared parameters, comments between items, and macro-created punctuation. Missing/duplicate-unbound definitions, unmatched positional count, macro-created punctuation, or mixed unsupported syntax produce blocking diagnostics and no patch.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/instanceNormalizer.test.js && node ./out/test/instancePatchPlanner.test.js`

Expected: positional parameters/ports, implicit, empty, wildcard precedence, complete-declaration rewrite, and read-only failure tests pass.

- [ ] **Step 5: Commit instance normalization**

```bash
git add veriflow-vscode/src/schematic/instanceNormalizer.ts veriflow-vscode/src/schematic/instancePatchPlanner.ts veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts veriflow-vscode/src/test/instanceNormalizer.test.ts veriflow-vscode/src/test/instancePatchPlanner.test.ts
git commit -m "feat: normalize legacy instance connections"
```

### Task 5: Generate Constructs, Instance Arrays, And Opaque Logic

**Files:**
- Create: `veriflow-vscode/src/schematic/elaborationModel.ts`
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Modify: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/commandReducer.ts`
- Modify: `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`
- Create: `veriflow-vscode/src/test/schematicElaboration.test.ts`

- [ ] **Step 1: Write failing elaboration-model tests**

```typescript
const knownFor = await elaborateFixture('for-generate-known.sv', { COUNT: 4 });
assert.deepStrictEqual(knownFor.nodes.map(node => [node.kind, node.label, node.readOnly]), [
  ['generateArray', 'u_stage[0..3]', false],
]);
assert.strictEqual(knownFor.nodes[0].elements.length, 4);
assert.throws(() => editGeneratedElement(knownFor, 2), /shared template/);

const unknownCase = await elaborateFixture('case-generate-symbolic.sv', {});
assert.strictEqual(unknownCase.nodes[0].kind, 'opaque');
assert.strictEqual(unknownCase.nodes[0].readOnly, true);
assert.ok(unknownCase.nodes[0].label.includes('case'));
```

Add `elaborateFixture` and `editGeneratedElement` to `schematicSemanticFixture.ts`; fixtures are parsed through the real adapter and `editGeneratedElement` dispatches through the real command reducer.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicElaboration.test.js`

Expected: FAIL because elaboration metadata is missing.

- [ ] **Step 3: Add normalized generate and array metadata**

```typescript
export type StructuralRegionModel =
  | { kind: 'ordinary'; instances: InstanceModel[] }
  | { kind: 'knownIf'; conditionText: string; active: boolean; templateSpan: SourceSpan; instances: InstanceModel[] }
  | { kind: 'generateArray'; label: string; first: number; last: number; templateSpan: SourceSpan; instances: InstanceModel[] }
  | { kind: 'opaqueGenerate'; label: string; span: SourceSpan; boundaryExpressions: ExpressionModel[] }
  | { kind: 'external'; externalKind: 'macro' | 'udp' | 'gate' | 'interface' | 'modport'; label: string; span: SourceSpan; boundaryExpressions: ExpressionModel[] };
```

Extract source template spans, condition AST, genvar bounds, instance array ranges, and boundary expressions. Evaluate only bounded constant conditions/loops; cap expanded inspection elements at 1,000 and keep larger known arrays collapsed with summarized range.

- [ ] **Step 4: Enforce shared-template editing**

Known active `if generate` instances are editable when uniquely mapped. A known `for generate` or explicit instance array exposes expanded elements for inspection but routes parameter/connection commands to the one shared template. Individual element rename/delete/reconnect is rejected. Unknown branches/bounds, macro instances, UDPs, gates, interfaces, and modports become visually distinct read-only external/opaque nodes with boundary networks.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicElaboration.test.js && node ./out/test/schematicGraph.test.js`

Expected: known/unknown if/case/for, array cap, shared template, explicit arrays, and external structure tests pass.

- [ ] **Step 5: Commit elaboration support**

```bash
git add veriflow-vscode/src/schematic/elaborationModel.ts veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/schematic/graphBuilder.ts veriflow-vscode/src/schematic/commandReducer.ts veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts veriflow-vscode/src/test/schematicElaboration.test.ts veriflow-vscode/src/test/schematicGraph.test.ts
git commit -m "feat: model generate and instance arrays"
```

### Task 6: Complete Diagnostic Presentation And Recovery

**Files:**
- Create: `veriflow-vscode/src/schematic/diagnosticPresenter.ts`
- Modify: `veriflow-vscode/src/schematic/graphValidator.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts`
- Create: `veriflow-vscode/src/test/schematicDiagnostics.test.ts`

- [ ] **Step 1: Write failing severity and presentation tests**

```typescript
const report = buildDiagnosticReport(allDiagnosticFixture());
assert.ok(report.blockingCodes.includes('SCHEMATIC_MULTIPLE_DRIVERS'));
assert.ok(report.blockingCodes.includes('SCHEMATIC_INOUT_WIDTH_MISMATCH'));
assert.ok(report.warningCodes.includes('SCHEMATIC_WIDTH_ADAPTER'));
assert.ok(report.warningCodes.includes('HDL_DUPLICATE_DEFINITION'));
assert.strictEqual(report.canGenerate, false);
assert.ok(report.problems.every(item => item.span));
assert.strictEqual(report.duplicatePopup, undefined);
```

Add `allDiagnosticFixture` to `schematicSemanticFixture.ts`; it includes one instance of every blocking and warning code listed in Step 3 with source spans where the originating model has one.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicDiagnostics.test.js`

Expected: FAIL because complete report/presentation mapping is absent.

- [ ] **Step 3: Centralize severity and generation policy**

```typescript
export type DiagnosticReport = {
  diagnostics: SchematicDiagnostic[]; blockingCodes: string[]; warningCodes: string[];
  canGenerate: boolean; problems: Array<{ uri: string; span: SourceSpan; severity: 'error' | 'warning'; message: string }>;
  duplicateOutputLines: string[]; duplicateStatusText?: string; duplicatePopup?: never;
};
export type DiagnosticInputs = {
  graphDiagnostics: readonly SchematicDiagnostic[];
  sourceDiagnostics: readonly SchematicDiagnostic[];
  parserDiagnostics: readonly HdlDiagnostic[];
  duplicateGroups: readonly DuplicateDefinitionGroup[];
  objectSpans: Readonly<Record<string, { uri: string; span: SourceSpan }>>;
};
export function buildDiagnosticReport(input: DiagnosticInputs): DiagnosticReport;
```

Blocking: stale source/preconditions, overlaps, invalid/duplicate identifiers, multiple drivers, illegal directions, missing new-instance definition, candidate syntax errors, known `inout` mismatch, and unmappable edits. Warnings: symbolic/unknown width, extension/truncation, deleted-port references, possible macro references, unconnected inputs, undriven outputs, unused existing wires, read-only structures, and duplicate definitions.

- [ ] **Step 4: Present each diagnostic at every useful surface**

Attach object IDs to node/pin/edge markers, show selected-object detail in inspector, counts in toolbar, and source-mappable diagnostics in one VS Code `DiagnosticCollection`. Duplicate definitions alone write a consolidated Output Channel block and status-bar summary, never a popup. Clicking a diagnostic selects its graph object and reveals source when a span exists.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/schematicDiagnostics.test.js`

Expected: complete code/severity, Generate gating, Problems mapping, object markers, navigation, and no-popup duplicate tests pass.

- [ ] **Step 5: Commit diagnostic completion**

```bash
git add veriflow-vscode/src/schematic/diagnosticPresenter.ts veriflow-vscode/src/schematic/graphValidator.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/src/test/helpers/schematicSemanticFixture.ts veriflow-vscode/src/test/schematicDiagnostics.test.ts
git commit -m "feat: complete schematic diagnostics"
```

### Task 7: Performance, Cancellation, Packaging, And Cross-Platform Stabilization

**Files:**
- Create: `veriflow-vscode/src/test/schematicPerformance.test.ts`
- Create: `veriflow-vscode/src/test/helpers/schematicBenchmark.ts`
- Create: `veriflow-vscode/scripts/benchmark-schematic.mjs`
- Create: `veriflow-vscode/scripts/serve-schematic-test.mjs`
- Create: `veriflow-vscode/playwright.config.mjs`
- Create: `veriflow-vscode/webview/schematic/test-harness.html`
- Create: `veriflow-vscode/webview/schematic/tests/schematic.spec.ts`
- Modify: `veriflow-vscode/src/core/hdl/protocol.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserWorker.ts`
- Modify: `veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserClient.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/webview/schematic/index.ts`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/package-lock.json`

- [ ] **Step 1: Add reproducible performance fixtures and budgets**

```typescript
import { benchmarkSchematic } from './helpers/schematicBenchmark';

const result = await benchmarkSchematic({ modules: 500, instancesPerTop: 1000, fanout: 8, seed: 1 });
assert.ok(result.graphElements > 5_000, JSON.stringify(result));
if (process.env.CI_PERF_REFERENCE === '1') {
  assert.ok(result.initialIndexMs < 10_000, JSON.stringify(result));
  assert.ok(result.singleFileRefreshMs < 1_000, JSON.stringify(result));
  assert.ok(result.graphBuildMs < 1_000, JSON.stringify(result));
  assert.ok(result.eventLoopMaxDelayMs < 150, JSON.stringify(result));
  assert.ok(result.workerHeapUsedDeltaMiB < 100, JSON.stringify(result));
}
```

Create the exact helper API:

```typescript
export type SchematicBenchmarkOptions = {
  modules: number; instancesPerTop: number; fanout: number; seed: number;
};
export type SchematicBenchmarkResult = {
  initialIndexMs: number;
  singleFileRefreshMs: number;
  graphBuildMs: number;
  eventLoopMaxDelayMs: number;
  workerHeapUsedDeltaMiB: number;
  graphElements: number;
};
export function benchmarkSchematic(options: SchematicBenchmarkOptions): Promise<SchematicBenchmarkResult>;
```

Generate all HDL in a temporary OS directory from the seed, use the real parser worker/index/graph request, and sample extension-process event-loop delay with a 10 ms timer. Capture `process.memoryUsage().heapUsed` inside the worker immediately before and after graph construction; unlike RSS, V8 heap fields are attributable to the current worker isolate. Report `max(0, after-before)` as `workerHeapUsedDeltaMiB`; do not label process-wide RSS as worker memory. `scripts/benchmark-schematic.mjs` imports the compiled helper from `out/test/helpers/schematicBenchmark.js`, writes JSON under `os.tmpdir()`, prints its absolute path, and enforces budgets only when `CI_PERF_REFERENCE=1`. Add `"benchmark:schematic": "npm run compile && node ./scripts/benchmark-schematic.mjs"`. The documented reference runner is GitHub `ubuntu-latest`, Node 20, with no other benchmark job in parallel.

- [ ] **Step 2: Run the benchmark and record the failing baseline**

Run: `cd veriflow-vscode && npm run benchmark:schematic`

Expected: before implementation, compile/run fails because the benchmark helper or worker graph API is missing. After implementation, a local run records metrics without budget assertions; only the CI reference environment enforces thresholds.

- [ ] **Step 3: Move graph construction into the HDL worker**

Extend the existing discriminated worker protocol:

```typescript
export type BuildGraphRequest = {
  type: 'buildGraph'; requestId: string; priority: 'interactive';
  uri: string; version: number; moduleKey: string;
  expectedDefinitionFingerprints: Record<HdlDefinitionKey, string>;
  definitions: Array<{ key: HdlDefinitionKey; modelFingerprint: string; model: ModuleModel }>;
};
export type GraphBuiltResponse = {
  type: 'graphBuilt'; requestId: string; graph: SchematicGraph;
  metrics: { buildMs: number; heapUsedBeforeMiB: number; heapUsedAfterMiB: number };
};
export type WorkerGraphResult = Pick<GraphBuiltResponse, 'graph' | 'metrics'>;
export class HdlParserClient {
  buildGraph(
    uri: string,
    version: number,
    moduleKey: string,
    expectedDefinitionFingerprints: Record<HdlDefinitionKey, string>,
    definitions: Array<{ key: HdlDefinitionKey; modelFingerprint: string; model: ModuleModel }>,
  ): Promise<WorkerGraphResult>;
}
```

Retain the latest adapted primary `HdlDocument` beside each document-mode tree. Before requesting a graph, the provider resolves every displayed/bound external definition through `WorkspaceHdlIndex.resolveDefinition` and sends its exact serializable `ModuleModel` plus current `modelFingerprint`; summaries alone are insufficient for parameterized ports. Also send the session baseline's expected fingerprint map. Widen the foundation queue to `ParserRequestQueue<ParseRequest | BuildGraphRequest>`, queue `buildGraph` at interactive priority, and run the pure `buildSchematicGraph` inside `parserWorker.ts` against the exact cached URI/version/module key and supplied full-model map. Return `HDL_GRAPH_BASELINE_MISSING` for a stale primary document and `HDL_GRAPH_DEFINITION_MISMATCH` when a required key is missing/duplicated or an entry's current fingerprint differs from `expectedDefinitionFingerprints[key]`. The provider first performs/awaits the interactive parse, resolves models, then requests the graph. Do not use `setImmediate` as the performance boundary: graph traversal and network construction must execute in the worker thread. Cancellation/request-generation checks in the client discard a graph superseded by a newer document version, definition invalidation, or disposed panel.

Extend `schematicPerformance.test.ts` to schedule a 1,000-instance graph build while a 10 ms extension-process timer runs; include an external parameterized child whose overridden width changes its pins, and assert the worker uses the supplied full model rather than only its summary. Assert the worker reports before/after heap metrics and the host event-loop delay remains under budget on the reference runner. Kill the worker during a graph request and assert the request rejects once and the next parse recreates the worker.

- [ ] **Step 4: Chunk and virtualize large Webview payloads**

Add exact host events:

```typescript
export type GraphTransferEvent =
  | { type: 'graphBegin'; transferId: string; moduleKey: string; totalChunks: number; totalElements: number }
  | { type: 'graphChunk'; transferId: string; chunkIndex: number; nodes: GraphNode[]; networks: SchematicNetwork[] }
  | { type: 'graphEnd'; transferId: string };
```

For at most 5,000 total nodes plus networks, retain the single `graph` event. Above that threshold, the provider sends deterministic chunks of at most 1,000 elements, checks panel disposal/cancellation between chunks, and ends only after every zero-based chunk arrives. The Webview validates transfer identity/index/count, ignores stale transfers, assembles once, and renders X6 with viewport virtualization enabled. Arrays above the elaboration cap remain collapsed.

Implement palette result virtualization with fixed 28 px rows and eight-row overscan; only the visible slice plus overscan exists in the DOM. Compute rendered graph bounds after layout and create the minimap only when width or height exceeds 1.5 times the corresponding viewport dimension; dispose it when the graph falls below the threshold. Search, selection, and inspector operate on graph data rather than only mounted DOM nodes.

- [ ] **Step 5: Add real Chromium interaction and geometry tests**

Pin `@playwright/test` to `1.54.2`. Add scripts:

```json
{
  "devDependencies": {
    "@playwright/test": "1.54.2"
  },
  "scripts": {
    "test:webview": "npm run compile && playwright test --config=playwright.config.mjs",
    "test:webview:install": "playwright install chromium"
  }
}
```

`playwright.config.mjs` uses Chromium, base URL `http://127.0.0.1:3210`, a `webServer` command `node ./scripts/serve-schematic-test.mjs`, desktop viewport `1440x900`, mobile viewport `390x844`, trace on first retry, and one worker for deterministic canvas geometry. The server exposes only `media/schematic/**` plus `webview/schematic/test-harness.html`. The harness defines `acquireVsCodeApi`, records posted commands in `window.__vscodeMessages`, and exposes `window.__sendHostEvent(event)` and `window.__graphStats()`.

In `schematic.spec.ts`, use stable `data-testid` attributes and real pointer/wheel input to cover: palette search/add with virtualization; dragging a port to an instance pin; branching an existing network; selecting/renaming a network; selecting an instance and setting a parameter; deleting an instance and a top port; undo/redo; inspector error display; zoom, background pan, box selection, search stepping, minimap threshold, and Relayout All. Assert posted protocol payloads, nonzero canvas bounding boxes, left-input/right-output geometry, orthogonal edge points, no text overlap, and no page errors at desktop/mobile sizes. Send a chunked graph above 5,000 elements, assert all cells exist in graph state while mounted cell DOM stays below 600, then pan to a distant node and assert it mounts and is selectable.

- [ ] **Step 6: Bound background work and add recovery stress tests**

Retain the foundation's one lazy prioritized worker. Debounce watcher batches by 100 ms, abort superseded index batches between files, persist once per completed batch, and drop parser request text from the client pending map immediately after response. Stress truncated modules, missing `endmodule`, invalid macro nesting, deleted files, renamed include files, worker crash, corrupted index, corrupted draft, rapidly changing documents, and panel disposal during parse/graph/chunk transfer. Assert structured diagnostics, worker recreation on the next request, no unhandled rejection, no source write, no partial index persistence, and no stale candidate/graph publication.

- [ ] **Step 7: Verify focused performance and browser suites**

Run: `cd veriflow-vscode && npm test && npm run test:webview && npm run benchmark:schematic`

Expected: Node suites and Chromium interaction suites pass; local benchmark emits metrics, and the CI reference run enforces all budgets.

- [ ] **Step 8: Commit performance and browser stabilization**

```bash
git add veriflow-vscode/src/test/schematicPerformance.test.ts veriflow-vscode/src/test/helpers/schematicBenchmark.ts veriflow-vscode/scripts/benchmark-schematic.mjs veriflow-vscode/scripts/serve-schematic-test.mjs veriflow-vscode/playwright.config.mjs veriflow-vscode/webview/schematic/test-harness.html veriflow-vscode/webview/schematic/tests/schematic.spec.ts veriflow-vscode/src/core/hdl/protocol.ts veriflow-vscode/src/core/hdl/parserWorker.ts veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts veriflow-vscode/src/core/hdl/parserClient.ts veriflow-vscode/src/schematic/graphBuilder.ts veriflow-vscode/src/schematic/schematicEditorProvider.ts veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/webview/schematic/index.ts veriflow-vscode/.vscodeignore veriflow-vscode/package.json veriflow-vscode/package-lock.json
git commit -m "test: stabilize schematic editor delivery"
```

### Task 8: VS Code Extension Host And Package Acceptance

**Files:**
- Create: `veriflow-vscode/src/test/runExtensionTests.ts`
- Create: `veriflow-vscode/scripts/assert-package-contents.mjs`
- Create: `veriflow-vscode/src/test/suite/index.ts`
- Create: `veriflow-vscode/src/test/suite/schematicExtensionHost.test.ts`
- Create: `veriflow-vscode/src/test/fixtures/extension-host/top.sv`
- Create: `veriflow-vscode/src/test/fixtures/extension-host/child.sv`
- Create: `veriflow-vscode/src/test/fixtures/extension-host/child_duplicate.sv`
- Create: `veriflow-vscode/src/test/fixtures/extension-host/ports.svh`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/package-lock.json`
- Modify: `veriflow-vscode/.vscodeignore`
- Create: `.github/workflows/vscode-schematic-ci.yml`

- [ ] **Step 1: Add the failing Extension Host launcher and acceptance entry**

Pin `@vscode/test-electron` to `2.5.2` and add:

```json
{
  "devDependencies": {
    "@vscode/test-electron": "2.5.2"
  },
  "scripts": {
    "test:extension": "npm run compile && node ./out/test/runExtensionTests.js",
    "test:all": "npm test && npm run test:webview && npm run test:extension",
    "check:package-contents": "npm run compile && node ./scripts/assert-package-contents.mjs"
  }
}
```

`runExtensionTests.ts` creates an OS temporary directory with `fs.promises.mkdtemp`, recursively copies `src/test/fixtures/extension-host` into it, and calls `runTests` with `extensionDevelopmentPath` at the extension root, `extensionTestsPath` at `out/test/suite/index.js`, the temporary workspace path in `launchArgs`, `--disable-extensions`, and `version: process.env.VSCODE_TEST_VERSION || 'stable'`. Remove only that verified temporary directory in `finally`; tests never edit tracked fixtures. `suite/index.ts` exports `async function run(): Promise<void>` and executes `runSchematicExtensionHostTests()`; failures reject with their assertion stack.

- [ ] **Step 2: Expose a bounded activation test API**

Return this API from `activate` without registering test-only commands:

```typescript
export type VeriFlowExtensionApi = {
  schematic: {
    getOpenPanelCount(uri: string): number;
    getSessionIdentity(uri: string): string | undefined;
    stageTestCommand(uri: string, moduleKey: string, command: GraphEditCommand): Promise<void>;
    generatePreview(uri: string): Promise<SourceCandidate>;
    applyPreview(uri: string, candidateId: string): Promise<void>;
    getDiagnosticPresentation(uri: string): {
      diagnostics: SchematicDiagnostic[];
      outputLines: string[];
      statusText?: string;
      popupRequested: boolean;
    };
  };
};
```

These methods delegate to the same session registry/planner/application/presenter services as Webview commands and are a supported read-only/command automation surface, not a second implementation. `getDiagnosticPresentation` returns the presenter's last immutable snapshot; `popupRequested` is recorded by the presentation port and must remain false for duplicate-only reports. They expose identities/counts/snapshots but no mutable internal maps.

- [ ] **Step 3: Exercise native editor, diff, diagnostics, apply, and Undo**

In `schematicExtensionHost.test.ts`, activate the installed development extension, open `top.sv` as text, execute `vscode.openWith` using `veriflow.schematicEditor` in two view columns, and assert two panels share one session identity. Stage a deterministic rename/connection through the API, generate, and assert the original URI plus a `veriflow-candidate` virtual document are open in a native Diff Editor with the exact candidate text. Change `ports.svh` and assert the preview invalidates while `top.sv` version/text stays unchanged; restore it, regenerate, then change `child.sv` and assert bound-definition invalidation.

Regenerate and apply. Observe `workspace.onDidChangeTextDocument`, assert exactly one full-document content change and no second `WorkspaceEdit`, then execute `undo` once and assert the exact pre-apply top source returns. The fixture deliberately contains one source-mappable graph warning and duplicate `child` definitions in `child.sv`/`child_duplicate.sv`; assert `vscode.languages.getDiagnostics(topUri)` contains the warning's code/range and `getDiagnosticPresentation(topUri)` contains both duplicate paths, a status summary, and `popupRequested === false`. The existing injected presenter unit test remains the exhaustive no-popup mapping test. Close one panel and assert the other session remains; close both and assert clean-session disposal.

- [ ] **Step 4: Add exact CI and package-content gates**

Create `.github/workflows/vscode-schematic-ci.yml` with Node 20 and these jobs. Every job starts with `actions/checkout`, `actions/setup-node` using `node-version: 20` and npm cache for `veriflow-vscode/package-lock.json`, then runs `npm ci` with `working-directory: veriflow-vscode` before any `npx` or package script:

- `unit-package`: matrix `windows-latest`, `ubuntu-latest`, `macos-latest`; after shared setup run `npm test`, `npm run lint`, `npm run check:package-contents`, `npm run package`, and `npx vsce ls`.
- `webview`: `ubuntu-latest`; after shared setup run the pinned local CLI through `npx --no-install playwright install --with-deps chromium`, then `npm run test:webview`.
- `extension-host`: `ubuntu-latest`; matrix `VSCODE_TEST_VERSION: ['1.82.3', 'stable']`; after shared setup run `xvfb-run -a npm run test:extension` with that environment value.
- `performance`: `ubuntu-latest`; after shared setup set `CI_PERF_REFERENCE=1` and run `npm run benchmark:schematic` alone.

Append browser tests, Extension Host fixtures/compiled suites, Playwright artifacts, benchmark scripts/helpers, and `.vsix` files to `.vscodeignore` while keeping `dist/**`, `media/schematic/**`, parser WASM, manifests, README/license/notices. Implement `assert-package-contents.mjs` with `import { listFiles, PackageManager } from '@vscode/vsce'` and the structured `listFiles({ cwd: process.cwd(), packageManager: PackageManager.Npm })` API: assert required exact paths for three runtime bundles, schematic HTML/CSS/JS, two WASM files, manifest, README/license/notices; reject paths under `src/`, `out/`, `scripts/`, `webview/`, test/fixture/benchmark folders, native `.node` binaries, maps, traces, draft/layout data, and `.vsix`. Fail with the complete unexpected/missing path lists.

- [ ] **Step 5: Run final acceptance and commit**

Run: `cd veriflow-vscode && npm test && npm run lint && npm run test:webview && npm run test:extension && npm run benchmark:schematic && npm run check:package-contents && npm run package && npx vsce ls`

Expected: functional, Chromium, current-stable Extension Host, lint, local metric, and package-content suites pass. CI separately proves VS Code 1.82.3, all three packaging operating systems, and reference performance budgets.

```bash
git add veriflow-vscode/src/test/runExtensionTests.ts veriflow-vscode/src/test/suite/index.ts veriflow-vscode/src/test/suite/schematicExtensionHost.test.ts veriflow-vscode/src/test/fixtures/extension-host veriflow-vscode/scripts/assert-package-contents.mjs veriflow-vscode/src/extension.ts veriflow-vscode/package.json veriflow-vscode/package-lock.json veriflow-vscode/.vscodeignore .github/workflows/vscode-schematic-ci.yml
git commit -m "test: accept schematic editor in VS Code"
```

## Plan Completion Gate

Run from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run test:webview
npm run test:extension
npm run benchmark:schematic
npm run check:package-contents
npm run package
npx vsce ls
rg -n "eval\(|new Function|Function\(" src
```

Expected results:

- known, symbolic, and unknown widths propagate from AST-evaluated parameters without dynamic JavaScript execution;
- known numeric widening calculates the width difference and emits `{N'd0, src}`, symbolic widening uses replication only when direction is known, and truncation respects actual declared range direction/bounds;
- adapters are load-local, visible, source-previewed, and never guessed for `inout`;
- positional, implicit, and wildcard connections normalize through the shared formatter on first supported edit;
- generate and instance arrays expose only safe shared-template editing while unsupported structures remain visible/read-only;
- all blocking/warning cases reach canvas, inspector, toolbar, Problems, Output, or status bar as appropriate;
- large workspaces remain responsive, failures recover without corrupting source/drafts, and the VSIX contains only required runtime assets;
- Chromium interaction tests cover the real X6 canvas, and Extension Host tests cover optional Open With, shared sessions, native diff, semantic invalidation, atomic apply, diagnostics, and one-step VS Code Undo;
- the final dynamic-evaluation search returns no matches in extension source.

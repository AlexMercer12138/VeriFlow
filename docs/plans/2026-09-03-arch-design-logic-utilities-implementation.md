# Arch Design Logic Utilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep Arch Design defaults out of the canvas and add persistent, editable Logic Utility nodes that export as continuous RTL assignments.

**Architecture:** Upgrade editable Arch Designs to schema v2 with a first-class discriminated `logic` collection and `logic` scalar endpoints. A shared core helper derives stable pins, roles, and widths for every operation; resolver, graph projection, Inspector, and RTL export consume that single projection. Effective defaults remain resolver data used by validation, Inspector, and export, while only explicit Logic Utilities become graph nodes.

**Tech Stack:** TypeScript, Node test runner, `@veriflow/schematic-core`, X6, VS Code webviews, Lucide icons, Verilog-2001/SystemVerilog continuous assignments.

---

### Task 1: Add The Schema-v2 Logic Model

**Files:**
- Create: `packages/schematic-core/src/archDesign/logic.ts`
- Modify: `packages/schematic-core/src/archDesign/model.ts`
- Modify: `packages/schematic-core/src/archDesign/parser.ts`
- Modify: `packages/schematic-core/src/archDesign/serializer.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Modify: `packages/schematic-core/test/archDesignModel.test.ts`
- Modify: `packages/schematic-core/test/archDesignParser.test.ts`
- Modify: `packages/schematic-core/test/archDesignSerialization.test.ts`

**Step 1: Write failing schema and round-trip tests**

Add tests proving that a schema-v1 document migrates to an editable schema-v2
snapshot with `logic: []`, a newly empty design serializes schema v2, every
operation round trips, malformed operation-specific properties report paths
beneath `$.logic[index]`, and an unknown version remains unsupported.

Use a representative value such as:

```ts
logic: [
    { name: 'u_const_0', operation: 'constant', width: 8, expression: "8'h5a" },
    { name: 'u_and_0', operation: 'and', width: 8, inputCount: 3 },
    { name: 'u_concat_0', operation: 'concat', inputWidths: [4, 8] },
    { name: 'u_slice_0', operation: 'slice', inputWidth: 16, msb: 11, lsb: 4 },
]
```

**Step 2: Run tests and verify the expected failure**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignModel.test.js packages/schematic-core/dist-test/test/archDesignParser.test.js packages/schematic-core/dist-test/test/archDesignSerialization.test.js
```

Expected: FAIL because schema v2, `logic`, and operation normalization do not exist.

**Step 3: Implement the model and one pin-definition helper**

Define a discriminated `ArchDesignLogic` union, add `logic` to `ArchDesign`, and
add this endpoint variant:

```ts
Readonly<{ kind: 'logic'; logic: string; port: string }>
```

In `logic.ts`, expose immutable operation metadata and a function shaped like:

```ts
export function archDesignLogicPins(
    logic: ArchDesignLogic
): readonly Readonly<{
    name: string;
    role: 'driver' | 'load';
    width: WidthValue;
}>[];
```

Use stable input names `in`, `in0`...`in7`, `select`, and output `out`.
Normalize v1 documents into the v2 runtime model, serialize only v2, validate
constant expressions with `isSafeDefaultExpression`, bound gate/concat input
counts to 2-8, and keep dictionaries/arrays owned and frozen like the existing
parser.

**Step 4: Re-run focused tests**

Expected: all focused model/parser/serializer tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesignModel.test.ts packages/schematic-core/test/archDesignParser.test.ts packages/schematic-core/test/archDesignSerialization.test.ts
git commit -m "feat(ad): add schema-v2 logic model"
```

### Task 2: Add Atomic Logic Edits And Command Validation

**Files:**
- Modify: `packages/schematic-core/src/archDesign/edit.ts`
- Modify: `packages/schematic-core/test/archDesignEdit.test.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`

**Step 1: Write failing reducer and protocol tests**

Cover `addLogic`, `updateLogic`, and `removeLogic`. Prove rename cascades through
connection endpoints, design/connection defaults, and `presentation.nodes`;
removal drops matching endpoints and empty connections without touching other
nodes. Assert the webview command parser accepts valid utility edits and rejects
invalid operations, widths, counts, slice bounds, and expressions.

**Step 2: Run focused tests and verify failure**

Run the schematic-core focused build from Task 1 with
`archDesignEdit.test.js`, then:

```bash
npm run vscode:prepublish --workspace veriflow
npm test --workspace veriflow
```

Expected: FAIL because the edit union and protocol normalizer lack Logic Utilities.

**Step 3: Implement edits and validation**

Add:

```ts
| Readonly<{ type: 'addLogic'; logic: ArchDesignLogic }>
| Readonly<{ type: 'updateLogic'; name: string; logic: ArchDesignLogic }>
| Readonly<{ type: 'removeLogic'; name: string }>
```

Reuse parser normalization as the final reducer boundary rather than duplicating
semantic validation. Enforce one public name namespace across ports, instances,
and utilities. Extend endpoint clone, equality, rename, removal, default-key,
and presentation cleanup helpers. Mirror the same bounded shape checks at the
untrusted webview command boundary.

**Step 4: Re-run focused tests and commit**

```bash
git add packages/schematic-core/src/archDesign/edit.ts packages/schematic-core/test/archDesignEdit.test.ts veriflow-vscode/src/schematic/protocol.ts veriflow-vscode/src/test/schematicProtocol.test.ts
git commit -m "feat(ad): edit logic utilities atomically"
```

### Task 3: Resolve Logic Endpoints And Defaults

**Files:**
- Modify: `packages/schematic-core/src/archDesign/resolution.ts`
- Modify: `packages/schematic-core/src/archDesign/validation.ts`
- Modify: `packages/schematic-core/test/archDesignValidation.test.ts`
- Modify: `packages/schematic-core/test/archDesignInterfaces.test.ts`

**Step 1: Write failing resolution tests**

Assert that utility pins become endpoint targets with canonical identities such
as `logic:u_and_0:in0`, inputs are loads, outputs are drivers, unknown pins are
diagnosed, and known width mismatches/multiple drivers use existing diagnostic
codes. Assert unconnected utility inputs receive `implicit-zero`, explicit
connection/design defaults win, and utility outputs never receive defaults.

**Step 2: Run focused tests and verify failure**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignValidation.test.js packages/schematic-core/dist-test/test/archDesignInterfaces.test.js
```

Expected: FAIL because resolution does not snapshot utilities or recognize logic endpoints.

**Step 3: Implement one resolver path**

Snapshot `design.logic` with the other semantic arrays, project pins through
`archDesignLogicPins`, and add resolved utility records to
`ArchDesignResolution`. Extend canonical endpoint identity, path, default key,
declaration ordering, connection indexing, driver/load validation, and
effective-default selection. Keep implicit zero limited to instance and utility
loads; retain `implicit-inout-t` for top-level inout `t`.

**Step 4: Re-run focused tests and commit**

```bash
git add packages/schematic-core/src/archDesign/resolution.ts packages/schematic-core/src/archDesign/validation.ts packages/schematic-core/test/archDesignValidation.test.ts packages/schematic-core/test/archDesignInterfaces.test.ts
git commit -m "feat(ad): resolve logic utility endpoints"
```

### Task 4: Separate Derived Defaults From Explicit Graph Nodes

**Files:**
- Modify: `packages/schematic-core/src/archDesign/graph.ts`
- Modify: `packages/schematic-core/src/archDesign/presentation.ts`
- Modify: `packages/schematic-core/test/archDesignGraph.test.ts`
- Modify: `packages/schematic-core/test/archDesignPresentation.test.ts`
- Modify: `packages/schematic-core/test/archDesignInterfaces.test.ts`

**Step 1: Replace current default-node expectations with regressions**

Write tests proving implicit zero, explicit endpoint defaults, driverless
connection defaults, implicit inout `t`, and interface defaults create no graph
node whose ID starts with `default:`. Preserve the real receiver-only network.
Add tests proving an explicit Constant is a visible editable `constant` node
and every other utility is an editable `expression` node with stable pins.

**Step 2: Run focused tests and verify failure**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignGraph.test.js packages/schematic-core/dist-test/test/archDesignPresentation.test.js packages/schematic-core/dist-test/test/archDesignInterfaces.test.js
```

Expected: old tests/implementation still project derived constant nodes and no utility nodes.

**Step 3: Implement graph projection**

Delete `constantNode`, `interfaceDefaultNode`, default-only networks, and
derived-default placement. Project each resolved utility as `logic:<name>`;
map its pins to resolver identities and use `constant` only for the explicit
constant operation. Keep explicit scalar/interface networks with their actual
endpoints even when there is no visible driver. Presentation reconciliation
must retain utility placement and naturally discard obsolete `default:` IDs.

**Step 4: Re-run focused tests and commit**

```bash
git add packages/schematic-core/src/archDesign/graph.ts packages/schematic-core/src/archDesign/presentation.ts packages/schematic-core/test/archDesignGraph.test.ts packages/schematic-core/test/archDesignPresentation.test.ts packages/schematic-core/test/archDesignInterfaces.test.ts
git commit -m "feat(ad): show only explicit logic nodes"
```

### Task 5: Export Every Utility With Continuous Assignments

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/src/archDesign/fingerprint.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`
- Modify: `packages/schematic-core/test/archDesignSerialization.test.ts`

**Step 1: Write failing RTL golden tests**

Build one connected chain containing every operation. Assert exact deterministic
Verilog for bitwise gates, mux, MSB-first concat, slice, replicate, zero/sign
extension, and reductions. Cover implicit-zero and explicit defaults substituted
into unconnected inputs, collision-safe net names, presentation-insensitive
fingerprints, utility-sensitive fingerprints, and both output languages.

Expected expression forms include:

```verilog
assign n_and = n_a & n_b;
assign n_mux = n_select ? n_in1 : n_in0;
assign n_concat = {n_in0, n_in1};
assign n_zext = {{(16-8){1'b0}}, n_in};
assign n_reduce = ^n_in;
```

**Step 2: Run focused tests and verify failure**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignRtl.test.js packages/schematic-core/dist-test/test/archDesignSerialization.test.js
```

Expected: FAIL because utility outputs have no generated drivers.

**Step 3: Implement expression rendering**

Allocate or reuse the existing connection net for each used utility output.
Resolve each input to a connected net or `effectiveDefaults` expression. Render
one parenthesized continuous expression per used utility output in declaration
order. Use reduction operators only for reduction nodes, bitwise operators for
gates, and direct assignment when equal-width extension needs no padding.
Include `logic` in the semantic serialization consumed by fingerprints.

**Step 4: Run all schematic-core tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/src/archDesign/fingerprint.ts packages/schematic-core/test/archDesignRtl.test.ts packages/schematic-core/test/archDesignSerialization.test.ts
git commit -m "feat(ad): export logic utilities as assigns"
```

### Task 6: Add Utility Inspector And Endpoint Authoring

**Files:**
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorSupport.test.ts`

**Step 1: Write failing Inspector tests**

Assert `archDesignEndpointForPin` returns logic endpoints, selecting
`logic:<name>` shows operation-specific editable fields, changing a field emits
one complete `updateLogic` edit, input pins expose current/effective defaults,
and delete emits `removeLogic`.

**Step 2: Run VS Code tests and verify failure**

```bash
npm test --workspace veriflow
```

Expected: FAIL because logic graph nodes fall back to the design Inspector and cannot connect.

**Step 3: Implement Inspector projection**

Extend `ArchDesignInspectorModel.kind` with `logic`. Add a logic Inspector that
uses the same operation metadata as the add dialog, keeps computed outputs
read-only, parses widths through the existing helper, and builds complete
replacement values before emitting `updateLogic`. Extend pin selection and
connection occupancy/default lookup to `logic` nodes without parsing labels.

**Step 4: Re-run VS Code tests and commit**

```bash
git add veriflow-vscode/src/schematic/webviewSupport.ts veriflow-vscode/src/test/schematicWebviewSupport.test.ts veriflow-vscode/src/test/archDesignEditorSupport.test.ts
git commit -m "feat(ad): inspect and connect logic utilities"
```

### Task 7: Add The Logic Utility Toolbar Workflow

**Files:**
- Modify: `packages/schematic-webview/src/index.html`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`

**Step 1: Write failing webview interaction tests**

Exercise the toolbar button, operation selector, dynamic field visibility,
operation-specific defaults, automatic `u_<operation>_<n>` naming, manual-name
preservation, submit command, dialog focus restoration, narrow viewport fit,
and subsequent Inspector editing/deletion. Assert the constant node is visible
and no derived default box appears.

**Step 2: Run build and interaction tests to verify failure**

```bash
npm run build:web
npm test --workspace @veriflow/waveform-desktop
```

Expected: FAIL because the toolbar action and dialog are absent.

**Step 3: Implement the dialog and controls**

Add a Lucide `Component` icon button titled **Logic Utility**. Add one modal
whose operation select controls compact field groups for width, expression,
input count/widths, bounds, and repetition. Use native inputs/selects with
labels, stable dimensions, and existing dialog styles. Keep operation metadata
and constructor logic table-driven, validate before posting `addLogic`, and do
not add visible instructional copy or shortcut text.

**Step 4: Re-run webview/desktop tests and commit**

```bash
npm run build:web
npm test --workspace @veriflow/waveform-desktop
git add packages/schematic-webview/src packages/waveform-desktop/test/schematicWebview.test.ts veriflow-vscode/src/test/schematicAssets.test.ts web-dist/schematic
git commit -m "feat(ad): add logic utility authoring dialog"
```

### Task 8: Update Product Documentation And Verify The Release Surface

**Files:**
- Modify: `veriflow-vscode/README.md`
- Modify: `veriflow-vscode/README_zh-CN.md`
- Modify: `docs/plans/2026-08-09-schematic-arch-design-design.md`
- Modify: `docs/plans/2026-09-02-arch-design-authoring-ux-design.md`
- Modify: `web-dist/schematic/index.html`
- Modify: `web-dist/schematic/index.css`
- Modify: `web-dist/schematic/index.js`

**Step 1: Update stale documentation**

Replace statements that derived defaults become real graph nodes. Document
that defaults are Inspector/export-only and that explicit Logic Utilities
provide visible constants and combinational glue logic. Record schema v2 and
the supported operation set without turning the README into a UI tutorial.

**Step 2: Build all generated assets**

```bash
npm run build:web
npm run build
```

Expected: generated assets are deterministic and TypeScript compiles.

**Step 3: Run focused and full verification**

```bash
npm test --workspace @veriflow/schematic-core
npm test --workspace @veriflow/waveform-desktop
npm test --workspace veriflow
npm run verify:generated
npm test
git diff --check
git status --short
```

Expected: all commands exit 0. The native-Icarus-only schematic-core compile
test may remain skipped when `iverilog` is unavailable; WASM Icarus coverage
must pass.

**Step 4: Commit documentation and generated output**

```bash
git add veriflow-vscode/README.md veriflow-vscode/README_zh-CN.md docs/plans/2026-08-09-schematic-arch-design-design.md docs/plans/2026-09-02-arch-design-authoring-ux-design.md web-dist/schematic
git commit -m "docs(ad): document logic utilities"
```

**Step 5: Review the complete branch**

```bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git status --short
```

Expected: only planned Arch Design, webview, tests, docs, and generated assets
are changed; the worktree is clean.

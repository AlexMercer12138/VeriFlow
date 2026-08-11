# Arch Design Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic semantic validation, effective scalar defaults, top-level input/output/inout graph projection, and persisted placement projection for schema-v1 Arch Designs.

**Architecture:** Keep the implementation in the isolated `@veriflow/schematic-core/arch-design` subpath. Callers provide a small host-neutral module-definition catalog that is structurally compatible with the HDL workspace index; one internal resolver snapshots the design and catalog into stable endpoint metadata shared by validation and graph projection. The public graph result reuses `SchematicGraph` and `SchematicPlacement`, while path-aware Arch Design diagnostics and effective-default records remain available separately for future CLI and editor hosts.

**Tech Stack:** TypeScript, Node test runner, `@veriflow/hdl-core` width types, existing `@veriflow/schematic-core` graph/placement APIs.

---

## Scope Boundaries

This phase implements the second item in the approved Arch Design dependency
order. It includes:

- unique module-definition resolution for every instance;
- parameter-name, endpoint, endpoint-ownership, driver, and known-width checks;
- scalar defaults with `connection > design > implicit inout _t` precedence;
- safe default-expression checks suitable for later RTL emission;
- top-level input/output/inout graph cells and scalar/default networks;
- conversion of schema-v1 presentation entries into shared placement state.

It deliberately does not implement RTL emission, CLI commands, VS Code custom
document lifecycle, module palette operations, interface recognition, or
interface expansion. A document containing `interfaceConnections` receives a
localized `AD_INTERFACE_UNSUPPORTED` semantic error until the protocol phase
implements those connections. No Python source or Python test path is added.

Use these stable top-level port semantics:

- input: one internal driver pin named exactly as the port;
- output: one internal load pin named exactly as the port;
- inout: right-boundary cell with load pins `<name>_o`, `<name>_t`, followed by
  driver pin `<name>_i`; `_t` accepts width 1 or the port width;
- an undriven inout `_t` receives implicit `1'b1` so the external port remains
  high impedance;
- schema endpoint signals omitted from input/output ports normalize to
  `value`; inout endpoints must explicitly select `i`, `o`, or `t`.

Defaults use the schema-v1 receiver key convention `instance.port` or
`port.signal`. If a top-level port name and instance name make one key
ambiguous, validation reports the ambiguity rather than guessing. Scalar
defaults are rendered as derived constant nodes. Later collapsed interface
defaults remain hidden from the canvas as required by the approved design.

### Task 1: Define the Semantic Catalog and Resolve Instances

**Files:**
- Create: `packages/schematic-core/src/archDesign/definitions.ts`
- Create: `packages/schematic-core/src/archDesign/resolution.ts`
- Create: `packages/schematic-core/src/archDesign/validation.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Test: `packages/schematic-core/test/archDesignValidation.test.ts`

**Step 1: Write the failing catalog and instance-resolution tests**

Add a helper that parses complete schema-v1 values before testing semantics:

```ts
function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const result = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (result.status !== 'editable') throw new Error('expected editable design');
    return result.design;
}
```

Define a catalog with a uniquely resolved `source` module and cover:

```ts
const result = validateArchDesign(design, definitions);
assert.equal(result.valid, true);
assert.deepEqual(result.diagnostics, []);
```

Then add cases asserting exact path/code pairs for:

- no definition named by `$.instances[0].module` -> `AD_MODULE_UNRESOLVED`;
- two definitions with the same module name -> `AD_MODULE_AMBIGUOUS`;
- an override not present in the resolved module's parameter declarations ->
  `AD_PARAMETER_UNKNOWN` at the dictionary-key path;
- a valid override on a declared parameter does not produce a diagnostic;
- semantic diagnostics are emitted in deterministic path/code order.

**Step 2: Run the focused test to verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
```

Expected: TypeScript compilation fails because the semantic catalog and
`validateArchDesign` do not exist.

**Step 3: Add the public catalog and validation result types**

In `definitions.ts`, define only the metadata needed by Arch Design:

```ts
import type { WidthValue } from '@veriflow/hdl-core/model';

export type ArchDesignDefinitionParameter = Readonly<{
    name: string;
    defaultExpression?: string;
}>;

export type ArchDesignDefinitionPort = Readonly<{
    name: string;
    direction: 'input' | 'output' | 'inout';
    width: WidthValue;
}>;

export type ArchDesignModuleDefinition = Readonly<{
    key: string;
    name: string;
    parameters: readonly ArchDesignDefinitionParameter[];
    ports: readonly ArchDesignDefinitionPort[];
}>;
```

The shape must accept `HdlDefinitionSummary` structurally without adding an
`@veriflow/hdl-runtime` dependency.

In `validation.ts`, expose immutable result records:

```ts
export type ArchDesignDefaultOrigin = 'connection' | 'design' | 'implicit-inout-t';

export type ArchDesignEffectiveDefault = Readonly<{
    endpoint: string;
    expression: string;
    origin: ArchDesignDefaultOrigin;
    connection?: string;
}>;

export type ArchDesignValidationResult = Readonly<{
    valid: boolean;
    diagnostics: readonly ArchDesignDiagnostic[];
    effectiveDefaults: readonly ArchDesignEffectiveDefault[];
}>;
```

Reuse `ArchDesignDiagnostic` from `parser.ts`; do not create a second path/code
diagnostic family.

**Step 4: Implement one internal deterministic resolver**

In `resolution.ts`, snapshot definitions once and build code-unit ordered maps
without reading caller-owned arrays or getters repeatedly. Resolve each
instance by exact module name:

- zero matches: add `AD_MODULE_UNRESOLVED`;
- more than one match: add `AD_MODULE_AMBIGUOUS` and do not select one;
- exactly one: retain its `key`, parameter declarations, and port declaration
  order for validation and graph projection.

Validate parameter override keys against only the uniquely resolved module.
Use `compareCodeUnits` for dictionary keys and final diagnostics; never use
`localeCompare` in a deterministic core path. Freeze the returned public
validation result and all nested arrays/records.

**Step 5: Run the focused test and verify GREEN**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignValidation.test.js
```

Expected: all instance-resolution tests pass.

**Step 6: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignValidation.test.ts
git commit -m "feat: resolve Arch Design module definitions"
```

### Task 2: Validate Scalar Connectivity and Resolve Effective Defaults

**Files:**
- Create: `packages/schematic-core/src/archDesign/defaults.ts`
- Modify: `packages/schematic-core/src/archDesign/resolution.ts`
- Modify: `packages/schematic-core/src/archDesign/validation.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Test: `packages/schematic-core/test/archDesignValidation.test.ts`

**Step 1: Write failing endpoint and electrical-rule tests**

Add declaration-order fixtures with known and symbolic widths. Assert exact
diagnostics for:

- an unknown instance or top-level port endpoint (`AD_ENDPOINT_UNKNOWN`);
- input/output endpoint signal misuse and an inout endpoint without explicit
  `i`, `o`, or `t` (`AD_PORT_SIGNAL`);
- one endpoint appearing twice in a connection or across two connections
  (`AD_ENDPOINT_DUPLICATE` at the later declaration);
- more than one definite `driver` on a scalar network (`AD_MULTIPLE_DRIVERS`);
- unequal known endpoint widths (`AD_WIDTH_MISMATCH`);
- `_t` width other than 1 or the inout port width (`AD_INOUT_T_WIDTH`);
- a required undriven load with no default (`AD_UNDRIVEN_INPUT`);
- every interface connection (`AD_INTERFACE_UNSUPPORTED`) without inspecting
  or warning about missing protocol members.

Unknown or symbolic widths must not create a false mismatch.

**Step 2: Write failing default-precedence and safety tests**

Cover these cases:

```ts
assert.deepEqual(result.effectiveDefaults, [
    {
        endpoint: 'sink.data_i',
        expression: "1'b1",
        origin: 'connection',
        connection: 'data',
    },
]);
```

Assert:

- a connection default wins over a design default for the same undriven load;
- a design default applies to a connected driverless load and to a completely
  unconnected load by synthesizing an effective default;
- an undriven `<inout>.t` receives `1'b1` with origin
  `implicit-inout-t`, unless a design or connection override exists;
- defaults attached to a driver or bidirectional endpoint produce
  `AD_DEFAULT_RECEIVER`;
- an unknown or ambiguous default key produces `AD_DEFAULT_ENDPOINT`;
- unused connection-default keys not present in that connection produce
  `AD_DEFAULT_CONNECTION`;
- empty expressions, directives, comments, semicolons, control characters,
  and unbalanced delimiters produce `AD_DEFAULT_EXPRESSION`;
- literals, identifiers, selects, unary/binary operators, ternaries,
  concatenations, and replication expressions remain accepted.

**Step 3: Run the focused test to verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignValidation.test.js
```

Expected: new tests fail because endpoint/default resolution is absent.

**Step 4: Normalize endpoint identities and roles**

Use stable semantic identities:

```text
instance endpoint: instance:<instance-name>:<port-name>
top scalar endpoint: port:<port-name>:value
top inout endpoint: port:<port-name>:o|t|i
default key: <instance>.<port> or <port>.value|o|t|i
```

Map roles as follows:

```text
top input/value -> driver
top output/value -> load
top inout/i -> driver
top inout/o -> load
top inout/t -> load
instance input -> load
instance output -> driver
instance inout -> bidirectional
```

Resolve every endpoint once, retain its JSON path and declaration order, and
use canonical identity rather than object identity to detect duplicates. Do
not cascade unknown-port diagnostics when an instance module itself is
unresolved or ambiguous.

**Step 5: Implement conservative safe-expression checks and precedence**

`defaults.ts` should export a small expression validator for later exporter
reuse. It may accept Verilog constant-expression tokens, whitespace, balanced
`()`, `[]`, and `{}`, but must reject:

- empty or overlong expressions;
- `` ` `` directives/macros;
- `//` and `/*` comment starts;
- semicolons and ASCII control characters other than horizontal whitespace;
- quotes not used as the apostrophe in a Verilog numeric literal;
- mismatched or prematurely closing delimiters.

Do not implement a second HDL parser in this phase. Effective defaults are
materialized only when a load has no definite driver. Resolve precedence in
the fixed order `connection`, `design`, `implicit-inout-t`, and retain the
winning origin/path for future Inspector display.

**Step 6: Run focused and package tests**

Run:

```bash
npm run test --workspace @veriflow/schematic-core
```

Expected: all schematic-core tests pass.

**Step 7: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignValidation.test.ts
git commit -m "feat: validate Arch Design scalar semantics"
```

### Task 3: Project Arch Designs into the Shared Schematic Graph

**Files:**
- Create: `packages/schematic-core/src/archDesign/graph.ts`
- Modify: `packages/schematic-core/src/archDesign/resolution.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Test: `packages/schematic-core/test/archDesignGraph.test.ts`

**Step 1: Write the failing complete graph-projection test**

Build a design containing:

- one input and one output top-level port;
- one inout top-level port;
- two uniquely resolved module instances;
- one normal driven network;
- one driverless scalar network with a connection default;
- one design-level default for an otherwise unconnected input;
- manual presentation entries that this task leaves untouched.

Call:

```ts
const projection = projectArchDesignGraph(design, definitions, {
    fileUri: 'file:///workspace/soc_top.ad',
});
```

Assert the stable graph header, node order, node IDs, pin order, definition
keys, widths, network IDs, endpoint roles, and diagnostics. In particular:

```ts
assert.deepEqual(inoutNode.pins.map(pin => [pin.name, pin.direction]), [
    ['gpio_o', 'load'],
    ['gpio_t', 'load'],
    ['gpio_i', 'driver'],
]);
```

Assert input is a left boundary through its driver pin, output/inout are right
boundaries through their first load pin, and the inout readback network is
classified as feedback by `assignColumns`.

**Step 2: Write failing default-node and invalid-intermediate tests**

For an effective scalar default, assert a derived constant node with stable ID
and one `driver` pin is attached to the same network as the receiver. A
design-level default for a wholly unconnected receiver must create a stable
default-only network.

For unresolved modules and bad endpoints, assert projection does not throw,
retains the visible unresolved instance node, omits only impossible pins or
network endpoints, and maps semantic diagnostics into graph diagnostics with
severity `error`. The path-aware validation result must also be returned:

```ts
assert.equal(projection.validation.valid, false);
assert.equal(projection.graph.diagnostics[0].code, 'AD_MODULE_UNRESOLVED');
```

**Step 3: Run the focused test to verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignGraph.test.js
```

Expected: compilation fails because `projectArchDesignGraph` does not exist.

**Step 4: Implement the graph projection**

Expose:

```ts
export type ArchDesignGraphProjection = Readonly<{
    graph: SchematicGraph;
    validation: ArchDesignValidationResult;
}>;

export function projectArchDesignGraph(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[],
    options: Readonly<{ fileUri: string }>
): ArchDesignGraphProjection;
```

Use these IDs so presentation and typed edit commands can remain stable:

```text
port:<port-name>
instance:<instance-name>
default:<canonical-receiver-identity>
network:<connection-name>
network:default:<canonical-receiver-identity>
```

Instance pins remain in HDL declaration order. Top-level nodes remain in Arch
Design declaration order, with input ports first, then instances, then output
and inout boundary ports. Scalar networks remain in connection declaration
order; synthesized default-only networks follow in receiver declaration order.
Choose a known network width from resolved endpoints only when they agree;
otherwise use symbolic or unknown width without inventing bits.

Set editable semantic nodes/pins to `readOnly: false`. Derived default nodes
are `readOnly: true` because their source of truth is the receiver default in
the Inspector, not an independently movable/renamable cell. Never mutate or
attach caches to the input design or catalog.

**Step 5: Run focused and layout integration tests**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test \
  packages/schematic-core/dist-test/test/archDesignGraph.test.js \
  packages/schematic-core/dist-test/test/columns.test.js \
  packages/schematic-core/dist-test/test/layout.test.js
```

Expected: all selected tests pass.

**Step 6: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignGraph.test.ts
git commit -m "feat: project Arch Designs into schematic graphs"
```

### Task 4: Project Persisted AD Presentation into Shared Placement

**Files:**
- Create: `packages/schematic-core/src/archDesign/presentation.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Test: `packages/schematic-core/test/archDesignPresentation.test.ts`

**Step 1: Write the failing presentation-projection tests**

Using a valid graph projection, cover:

- an empty presentation produces automatic placement for every graph node;
- schema fields map as `offset -> yOffset` and
  `userPositioned -> fixed`;
- stale presentation IDs are discarded;
- derived default nodes receive automatic placement;
- duplicate orders normalize deterministically;
- boundary port columns remain assigned to their legal outer columns even if
  the persisted document requests an internal/invalid column;
- repeated projection is deeply equal and does not mutate `design.presentation`.

**Step 2: Run the focused test to verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignPresentation.test.js
```

Expected: compilation fails because the presentation adapter does not exist.

**Step 3: Implement the thin placement adapter**

Expose:

```ts
export function projectArchDesignPlacement(
    design: ArchDesign,
    graph: SchematicGraph
): SchematicPlacement;
```

Build the automatic assignment with `assignColumns(graph)`. Convert only own
presentation entries whose IDs are present in `graph.nodes` into a fresh
`SchematicPlacement`, then call `mergePlacement` so the existing core owns
column clamping, order normalization, offset safety, and new/stale node
handling. Do not duplicate placement algorithms in `archDesign`.

**Step 4: Run the focused test and package test**

Run:

```bash
npm run test --workspace @veriflow/schematic-core
```

Expected: all schematic-core tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignPresentation.test.ts
git commit -m "feat: project Arch Design presentation state"
```

### Task 5: Verify Package Boundaries and the Full Node Product Matrix

**Files:**
- Modify if required: `packages/flow-core/test/boundaries.test.ts`
- Modify if required: `packages/schematic-core/package.json`
- Test: existing workspace tests

**Step 1: Add or tighten boundary assertions**

Ensure the Arch Design subpath declarations expose validation, graph, defaults,
and presentation APIs while the package root still does not import or re-export
Arch Design runtime code. Assert no source file under
`packages/schematic-core/src/archDesign` imports VS Code, Electron, DOM, X6,
Node filesystem/process APIs, `@veriflow/hdl-runtime`, or product host code.

No new package dependency should be necessary: `WidthValue` comes from the
existing `@veriflow/hdl-core` dependency, and graph/placement types are local.

**Step 2: Run focused boundary and generated-asset checks**

Run:

```bash
npm run test --workspace @veriflow/flow-core
npm run verify:generated
```

Expected: boundary tests pass and canonical web assets remain unchanged.

**Step 3: Run the complete Node/Electron/VS Code suite**

Run:

```bash
xvfb-run -a npm test
git diff --check main..HEAD
git status --short
```

Expected:

- CLI, shared packages, Electron schematic tests, VS Code tests, and VSIX
  packaging all pass;
- no Python tests run;
- diff check is empty;
- only intentional committed Arch Design source, tests, and this plan differ
  from `main`.

**Step 4: Commit any necessary boundary-only changes**

```bash
git add packages/flow-core/test/boundaries.test.ts \
  packages/schematic-core/package.json
git commit -m "test: enforce Arch Design semantic boundaries"
```

Skip this commit when existing boundary coverage already proves the required
isolation and the worktree is clean.

## Follow-Up Phases

After this branch is reviewed and integrated, continue in dependency order:

1. deterministic Verilog-2001 exporter and optional SystemVerilog output;
2. `veriflow ad validate` and `veriflow ad export`;
3. `.ad` VS Code custom document lifecycle and typed edit commands;
4. instance palette, ports, parameters, scalar connection creation, validation,
   placement persistence, and explicit export controls;
5. protocol recognition, collapsed interfaces, interface defaults, and
   project-defined protocol schemas.

Each phase remains TypeScript/Node-only and preserves `.v`/`.sv` schematics as
read-only views.

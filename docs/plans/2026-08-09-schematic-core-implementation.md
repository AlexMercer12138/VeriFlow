# Shared Schematic Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the existing Dagre/X6 schematic layout and pairwise routing with a shared TypeScript column/channel router, then use it for existing Verilog and SystemVerilog schematic views.

**Architecture:** Add `@veriflow/schematic-core` as a host-neutral package that owns graph types, pin normalization, semantic placement, node geometry, abstract track planning, network-tree routing, simplification, and junction derivation. Keep VS Code persistence and X6 rendering behind compatibility adapters until the core render model covers every existing HDL schematic path; then remove Dagre and the old webview midpoint router.

**Tech Stack:** TypeScript 5.9, Node `node:test`, X6 3.1, esbuild, VS Code custom webviews, npm workspaces.

---

## Scope Boundary

This plan implements delivery stages 1-3 from the approved design:

1. Extract a shared schematic graph and geometry package.
2. Implement deterministic column placement and orthogonal network routing.
3. Integrate the new render model into the existing `.v/.sv` schematic view.

The `.ad` schema, interface protocol recognition, connection editing, and RTL
export remain the next implementation plan. Do not add placeholder `.ad`
commands or partially implemented interface detection in this phase.

Every production change follows `@superpowers:test-driven-development`: write
one failing test, run it and confirm the expected failure, add the smallest
implementation, rerun, then refactor. Use
`@superpowers:characterization-testing` for Task 1 and
`@superpowers:verification-before-completion` before every commit.

### Task 1: Characterize the Existing Integration Boundary

**Files:**
- Modify: `veriflow-vscode/src/test/schematicLayout.test.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`
- Modify: `veriflow-vscode/src/test/schematicIntegration.test.ts`

**Step 1: Add characterization tests for behavior that must survive**

Add focused cases that capture public behavior, not the geometry defects being
replaced:

```typescript
async function testLayoutPersistenceKeepsViewportSelectionAndManualIntent(): Promise<void> {
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    await store.save('file:///top.sv', 'module:top:0', {
        nodes: { 'instance:u0': { x: 300, y: 120, fixed: true } },
        viewport: { x: 11, y: 22, zoom: 1.5 },
        minimap: false,
        selectedObjectId: 'network:data',
    });

    const loaded = store.load('file:///top.sv', 'module:top:0');
    assert.equal(loaded?.selectedObjectId, 'network:data');
    assert.deepEqual(loaded?.viewport, { x: 11, y: 22, zoom: 1.5 });
    assert.equal(loaded?.nodes['instance:u0'].fixed, true);
}
```

Also capture these boundaries:

- node and network IDs remain the selection/navigation identity;
- source reveal and open-definition commands are unchanged;
- relayout clears manual placement intent but preserves viewport and minimap;
- a graph refresh retains placement for matching node IDs and drops stale IDs;
- malformed saved layout data is rejected rather than partially trusted.

Do not assert bottom-pin placement, fixed Dagre coordinates, midpoint trunks,
or current feedback coordinates. Those are intentional replacement targets.

**Step 2: Run the focused VS Code tests**

Run:

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicLayout.test.js
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/schematicIntegration.test.js
```

Expected: PASS. These are characterization tests, so inspect actual behavior
and correct assertions if a test reveals a different stable contract.

**Step 3: Commit the characterization boundary**

```bash
git add veriflow-vscode/src/test/schematicLayout.test.ts \
  veriflow-vscode/src/test/schematicWebviewSupport.test.ts \
  veriflow-vscode/src/test/schematicIntegration.test.ts
git commit -m "test: characterize schematic integration boundary"
```

### Task 2: Scaffold the Shared Package and Move Graph Types

**Files:**
- Create: `packages/schematic-core/package.json`
- Create: `packages/schematic-core/tsconfig.json`
- Create: `packages/schematic-core/tsconfig.test.json`
- Create: `packages/schematic-core/src/model.ts`
- Create: `packages/schematic-core/src/index.ts`
- Create: `packages/schematic-core/test/model.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/flow-core/test/boundaries.test.ts`
- Modify: `packages/schematic-webview/package.json`
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/src/schematic/graphModel.ts`

**Step 1: Write the failing shared-package boundary test**

Add `@veriflow/schematic-core` to `sharedPackages` in
`packages/flow-core/test/boundaries.test.ts`, then run:

```bash
npm test --workspace @veriflow/flow-core
```

Expected: FAIL because `packages/schematic-core/package.json` does not exist.

**Step 2: Add the package manifest and TypeScript configs**

Follow `packages/hdl-core` conventions. The manifest must expose `.` and
`./model`, depend on `@veriflow/hdl-core` version `1.4.0`, and use:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepack": "npm run build",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "npm run build && tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js"
  }
}
```

Add the package after `@veriflow/hdl-core` in root `build:shared`,
`typecheck:shared`, and `test:shared`. Add it as a `1.4.0` dependency of the VS
Code extension and as a workspace dependency of the private schematic
webview. Run `npm install` once to update the lockfile.

**Step 3: Move the graph model behind a compatibility re-export**

Create `packages/schematic-core/src/model.ts` with the current graph types
unchanged for this compatibility commit:

```typescript
import type { HdlDiagnostic, SourceSpan, WidthValue } from '@veriflow/hdl-core/model';

export type PinDirection = 'driver' | 'load' | 'bidirectional';

export type GraphPin = {
    id: string;
    name: string;
    direction: PinDirection;
    side: 'left' | 'right' | 'bottom';
    width: WidthValue;
    readOnly: boolean;
    sourceSpan?: SourceSpan;
};
```

Move the remaining `GraphNode`, `NetworkEndpoint`, `SchematicNetwork`, and
`SchematicGraph` definitions unchanged. Make
`veriflow-vscode/src/schematic/graphModel.ts` a temporary compatibility shim:

```typescript
export * from '@veriflow/schematic-core/model';
```

Export the types from `packages/schematic-core/src/index.ts`.

**Step 4: Add and run a public-model test**

In `packages/schematic-core/test/model.test.ts`, construct a complete graph
and assert IDs, endpoint roles, side values, and width values round-trip through
a typed helper. The side assertion characterizes the temporary compatibility
shape and is intentionally replaced in Task 3. Run:

```bash
npm test --workspace @veriflow/schematic-core
npm test --workspace @veriflow/flow-core
```

Expected: core and boundary tests pass. Also run
`npm run compile:ts --prefix veriflow-vscode`; it must pass before committing.

**Step 5: Commit the package boundary**

```bash
git add package.json package-lock.json packages/schematic-core \
  packages/flow-core/test/boundaries.test.ts \
  packages/schematic-webview/package.json veriflow-vscode/package.json \
  veriflow-vscode/src/schematic/graphModel.ts
git commit -m "refactor: add shared schematic core package"
```

### Task 3: Normalize Pin Sides and Size Nodes Without Bottom Pins

**Files:**
- Create: `packages/schematic-core/src/pins.ts`
- Create: `packages/schematic-core/src/nodeGeometry.ts`
- Create: `packages/schematic-core/test/pins.test.ts`
- Create: `packages/schematic-core/test/nodeGeometry.test.ts`
- Modify: `packages/schematic-core/src/index.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/layoutStore.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `veriflow-vscode/src/test/schematicGraph.test.ts`
- Modify: `veriflow-vscode/src/test/schematicLayout.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`

**Step 1: Write failing pin-normalization tests**

Test the wished-for API:

```typescript
test('places loads left, drivers right, and resolves bidirectional peers', () => {
    const result = resolvePinSides(graphWithBidirectionalPair());
    assert.equal(result.get('instance:sink\0instance:sink:data'), 'left');
    assert.equal(result.get('instance:source\0instance:source:data'), 'right');
    assert.equal([...result.values()].includes('bottom' as never), false);
});
```

Cover deterministic fallback for an all-bidirectional network and top-level
inout placement on the right boundary. Run the core test and confirm it fails
because `resolvePinSides` is missing.

**Step 2: Remove semantic pin sides and verify the compilation red state**

Remove `side` from `GraphPin` and add the renderer-only `PinSide` type. Update
the model test to construct pins without `side`, then run:

```bash
npm test --workspace @veriflow/schematic-core
npm run compile:ts --prefix veriflow-vscode
```

Expected: the core model test passes and extension compilation fails only at
legacy `pin.side` producers or consumers. This is the expected refactoring red
state; do not commit until all failures are resolved below.

**Step 3: Implement semantic pin-side resolution**

Export:

```typescript
export type PinKey = `${string}\0${string}`;
export function pinKey(nodeId: string, pinId: string): PinKey;
export function resolvePinSides(graph: SchematicGraph): ReadonlyMap<PinKey, PinSide>;
```

Use endpoint roles first. For `bidirectional`, inspect peer driver/load roles
and directed column tendency. Resolve remaining ties by stable node and pin
source order. Top-level input ports resolve right-facing, while output and
inout boundary cells resolve left-facing internally. No output may be
`bottom`.

**Step 4: Write failing node-size tests**

Use an injected measurer:

```typescript
const measure: TextMeasurer = text => text.length * 7;
const geometry = measureSchematicNode(nodeWithLongPins, sideMap, measure);
assert.ok(geometry.width >= geometry.leftLabelWidth
    + geometry.centerWidth + geometry.rightLabelWidth);
assert.equal(geometry.height, HEADER_HEIGHT + 3 * PIN_ROW_HEIGHT + VERTICAL_PADDING);
assert.ok(geometry.pins.every(pin => pin.x === 0 || pin.x === geometry.width));
```

Also assert declaration order, grid-aligned pin Y coordinates, maximum width,
ellipsis metadata, and label clip bounds.

**Step 5: Implement node measurement and temporary adapters**

Add `TextMeasurer`, `MeasuredNode`, `ResolvedPin`, constants, and
`measureSchematicNode`. Remove `pinSide()` and all `side` properties from
`graphBuilder.ts`. Update graph tests to assert semantic roles only.

Keep `schematicNodeSize()` in `layoutStore.ts` as a compatibility adapter that
calls the core with deterministic fallback metrics. In the webview, replace
the bottom port group with left and right groups and use the resolved core pin
geometry. Do not change network routing yet.

**Step 6: Run focused tests and web build**

```bash
npm test --workspace @veriflow/schematic-core
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicGraph.test.js
node veriflow-vscode/out/test/schematicLayout.test.js
node veriflow-vscode/out/test/schematicAssets.test.js
npm run build:web
```

Expected: PASS and no `bottom` pin group in generated schematic JavaScript.

**Step 7: Commit the pin model migration**

```bash
git add packages/schematic-core veriflow-vscode/src/schematic/graphBuilder.ts \
  veriflow-vscode/src/schematic/layoutStore.ts \
  packages/schematic-webview/src/index.ts veriflow-vscode/src/test
git commit -m "refactor: place schematic pins on module sides"
```

### Task 4: Assign Directed Columns Deterministically

**Files:**
- Create: `packages/schematic-core/src/columns.ts`
- Create: `packages/schematic-core/test/columns.test.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write failing column-assignment tests**

Cover a chain, fan-out, disconnected island, feedback cycle, top-level
boundaries, and stable input order:

```typescript
test('condenses feedback and keeps forward data flow in columns', () => {
    const columns = assignColumns(feedbackGraph());
    assert.equal(columns.nodeColumn.get('port:input'), 0);
    assert.equal(columns.nodeColumn.get('instance:a'), 1);
    assert.equal(columns.nodeColumn.get('instance:b'), 1);
    assert.equal(columns.nodeColumn.get('port:output'), 2);
});
```

Assert top-level inout belongs to the right boundary and repeated runs produce
deep-equal results. Run the test and confirm the missing API failure.

**Step 2: Implement directed hypergraph construction**

Build one node-to-node dependency edge for each driver/load relation without
expanding duplicate endpoint pairs. Exclude self edges. For driverless
networks, infer one stable source only for placement; retain the original
network semantics.

**Step 3: Implement Tarjan SCC and longest-path rank assignment**

Condense SCCs to a DAG. Fix input boundary nodes at rank 0. Assign internal
SCCs by deterministic longest path. Move output and inout boundary nodes to
one final rank after the deepest internal node. Sort nodes inside each column
by graph/source order; do not barycentrically reorder pins or nodes.

Export:

```typescript
export type ColumnAssignment = {
    columns: readonly (readonly string[])[];
    nodeColumn: ReadonlyMap<string, number>;
    feedbackNetworkIds: ReadonlySet<string>;
};

export function assignColumns(graph: SchematicGraph): ColumnAssignment;
```

**Step 4: Run tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src/columns.ts \
  packages/schematic-core/src/index.ts packages/schematic-core/test/columns.test.ts
git commit -m "feat: add directed schematic column assignment"
```

### Task 5: Introduce Semantic Placement and Layout Migration

**Files:**
- Create: `packages/schematic-core/src/placement.ts`
- Create: `packages/schematic-core/test/placement.test.ts`
- Modify: `packages/schematic-core/src/index.ts`
- Modify: `veriflow-vscode/src/schematic/layoutStore.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/test/schematicLayout.test.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`

**Step 1: Write failing semantic-placement tests**

Define the version-2 shape through tests:

```typescript
const placement: SchematicPlacement = {
    nodes: {
        'instance:u0': { column: 2, order: 1, yOffset: 12, fixed: true },
    },
};
```

Test that automatic placement fills missing nodes, manual column and row
choices survive a graph refresh, stale IDs disappear, relayout clears manual
intent, and legacy `{x,y,fixed}` entries seed the automatically assigned
column plus a Y-sorted row order once.

**Step 2: Implement placement normalization and merge**

Export pure functions:

```typescript
export function createPlacement(
    graph: SchematicGraph,
    assignment: ColumnAssignment
): SchematicPlacement;

export function mergePlacement(
    graph: SchematicGraph,
    assignment: ColumnAssignment,
    persisted?: SchematicPlacement
): SchematicPlacement;

export function moveNodeToColumn(
    placement: SchematicPlacement,
    nodeId: string,
    column: number,
    order: number,
    yOffset: number
): SchematicPlacement;
```

Clamp columns, normalize order to a unique stable sequence, and reject
non-finite offsets. Boundary nodes ignore attempts to move across sides.

**Step 3: Upgrade the VS Code storage envelope**

Change `SchematicLayoutStore` to schema version 2. Keep viewport, minimap, and
selection in the host envelope, but store semantic placement rather than
absolute node centers. Read schema version 1 only through a migration helper;
never write version 1 again. Update protocol parsing with the same bounds and
prototype-safety checks used today.

**Step 4: Run focused tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicLayout.test.js
node veriflow-vscode/out/test/schematicProtocol.test.js
git add packages/schematic-core veriflow-vscode/src/schematic/layoutStore.ts \
  veriflow-vscode/src/schematic/protocol.ts \
  veriflow-vscode/src/test/schematicLayout.test.ts \
  veriflow-vscode/src/test/schematicProtocol.test.ts
git commit -m "refactor: persist semantic schematic placement"
```

### Task 6: Add Orthogonal Geometry, Occupancy, and Junction Primitives

**Files:**
- Create: `packages/schematic-core/src/routing/geometry.ts`
- Create: `packages/schematic-core/src/routing/occupancy.ts`
- Create: `packages/schematic-core/src/routing/junctions.ts`
- Create: `packages/schematic-core/test/routingGeometry.test.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write failing geometry tests**

Specify the segment API:

```typescript
const simplified = simplifySegments([
    horizontal('n', 0, 20, 10),
    horizontal('n', 20, 40, 10),
    vertical('n', 40, 10, 30),
]);
assert.deepEqual(simplified, [
    horizontal('n', 0, 40, 10),
    vertical('n', 40, 10, 30),
]);
```

Add separate tests for zero-length removal, reversed endpoints,
different-network overlap rejection, same-network interval union,
perpendicular crossing allowance, module-bound intersection, and direction-set
junction rules.

**Step 2: Implement canonical geometry types**

Use integer grid coordinates and normalized endpoints:

```typescript
export type Point = { x: number; y: number };
export type HorizontalSegment = {
    orientation: 'horizontal'; networkId: string; y: number; x1: number; x2: number;
};
export type VerticalSegment = {
    orientation: 'vertical'; networkId: string; x: number; y1: number; y2: number;
};
export type RouteSegment = HorizontalSegment | VerticalSegment;
```

Implement interval intersection without floating-point epsilon rules. Merge
only same-network collinear intervals. Split merged segments at branch points
before deriving junctions.

**Step 3: Implement reservation indexes**

Index vertical reservations by channel/track and horizontal reservations by
corridor/track. A reservation conflicts only when a different network covers
an overlapping open interval. Pin endpoints may touch; collinear sharing may
not occur.

**Step 4: Run tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src/routing packages/schematic-core/src/index.ts \
  packages/schematic-core/test/routingGeometry.test.ts
git commit -m "feat: add schematic routing geometry primitives"
```

### Task 7: Plan Channels, Corridors, and Dynamic Spacing

**Files:**
- Create: `packages/schematic-core/src/routing/grid.ts`
- Create: `packages/schematic-core/src/routing/tracks.ts`
- Create: `packages/schematic-core/test/routingGrid.test.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write failing abstract-grid tests**

Build fixtures with unequal node widths and heights. Assert:

- one vertical channel exists between each adjacent column;
- horizontal corridor candidates are clear across their requested column span;
- a blocked local corridor falls back to an outer corridor;
- adding tracks increases only the affected gap;
- an empty channel remains at minimum compact width;
- final coordinates are deterministic and grid aligned.

Use track indices in expected values, not final pixels:

```typescript
assert.deepEqual(planCorridors(layout, 0, 3), [
    { kind: 'internal', rowGap: 1, span: [0, 3] },
    { kind: 'outer-top', lane: 0, span: [0, 3] },
    { kind: 'outer-bottom', lane: 0, span: [0, 3] },
]);
```

**Step 2: Implement the abstract grid**

Represent node columns, vertical channel track pools, horizontal row-gap track
pools, and top/bottom feedback pools. Corridor validity uses inflated module
bounds that include pin escape and safety margins.

**Step 3: Implement demand-based coordinate realization**

First allocate abstract channel and corridor tracks. Then calculate each
column's maximum measured node width and each gap's exact route demand. Realize
node bounds, pin anchors, and route track coordinates once. Do not remap or
shrink already generated route points.

**Step 4: Run tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src/routing packages/schematic-core/src/index.ts \
  packages/schematic-core/test/routingGrid.test.ts
git commit -m "feat: plan compact schematic routing channels"
```

### Task 8: Route Complete Networks and Feedback Trees

**Files:**
- Create: `packages/schematic-core/src/routing/router.ts`
- Create: `packages/schematic-core/test/router.test.ts`
- Create: `packages/schematic-core/test/fixtures.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write failing route-shape tests**

Test one behavior per case:

```typescript
test('routes a non-adjacent connection as H-V-H-V-H', () => {
    const route = routeFixture(threeColumnFixture());
    assert.deepEqual(route.networks[0].paths[0].segments.map(segment =>
        segment.orientation), [
        'horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal',
    ]);
});
```

Add tests for direct adjacent horizontal routing, adjacent `H-V-H`, blocked
middle rows, no module intersection, different-net track separation,
same-net fan-out reuse, multi-driver geometry, and no redundant bends.

**Step 2: Implement deterministic point-to-point routing**

For each terminal pair, try candidates in this order:

1. direct adjacent horizontal;
2. nearest internal corridor by Manhattan cost and stable corridor ID;
3. nearest outer corridor.

Allocate a source channel track, horizontal corridor track, and target channel
track. Reject a candidate on obstacle or reservation conflict. Collapse
zero-length stages after coordinate realization, so aligned paths may contain
fewer than the maximum segment count.

**Step 3: Build one tree per network**

Sort terminals deterministically by column, row, node ID, and pin ID. Start
with the first terminal and repeatedly connect the cheapest remaining terminal
to an existing tree point or segment. Prefer a same-net trunk reuse on equal
cost. Union the resulting segments before rendering. Do not construct a
complete driver/load Cartesian product or a pairwise MST.

**Step 4: Route feedback only through outer lanes**

Use the SCC/column result to mark a network as feedback when any load is not to
the right of a driver. Evaluate top and bottom candidate cost using added
length and current lane count; break ties toward top, then alternate only when
cost remains equal. Route every endpoint horizontally from its side pin before
joining the outer lane.

**Step 5: Verify route properties and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src/routing/router.ts \
  packages/schematic-core/src/index.ts packages/schematic-core/test
git commit -m "feat: route schematic networks as orthogonal trees"
```

### Task 9: Compose the Shared Render Model

**Files:**
- Create: `packages/schematic-core/src/renderModel.ts`
- Create: `packages/schematic-core/src/layout.ts`
- Create: `packages/schematic-core/test/layout.test.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write a failing end-to-end core test**

Exercise a graph containing input/output/inout boundaries, unequal modules,
fan-out, a skipped column, and feedback. Assert the complete public result:

```typescript
const result = layoutSchematic(graph, placement, text => text.length * 7);
assert.equal(result.nodes.size, graph.nodes.length);
assert.ok(result.networks.every(network =>
    network.segments.every(isOrthogonal)));
assert.ok(result.junctions.every(junction => junction.directions.size >= 3));
assertNoNodeIntersections(result);
assertNoDifferentNetworkOverlaps(result);
```

Run twice and deep-compare serialized results.

**Step 2: Define the renderer-facing contract**

```typescript
export type SchematicRenderModel = {
    columns: readonly LayoutColumn[];
    nodes: ReadonlyMap<string, RenderedNodeGeometry>;
    networks: readonly NetworkRoute[];
    junctions: readonly Junction[];
    bounds: Rectangle;
};

export function layoutSchematic(
    graph: SchematicGraph,
    placement: SchematicPlacement | undefined,
    measureText: TextMeasurer
): SchematicRenderModel;
```

Add JSON-friendly serialization helpers for tests and host messages, but keep
the internal maps read-only.

**Step 3: Compose normalization, placement, routing, and labels**

The function runs the approved pipeline in one direction. Do not call Dagre or
X6. Network label candidates come from the longest clear horizontal segment;
if no label fits without intersecting a node, omit it and preserve the full
name in selection details.

**Step 4: Run core tests and commit**

```bash
npm test --workspace @veriflow/schematic-core
git add packages/schematic-core/src packages/schematic-core/test/layout.test.ts
git commit -m "feat: compose shared schematic render model"
```

### Task 10: Render Core Geometry in X6

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/package.json`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `veriflow-vscode/src/test/webDistAssets.test.ts`

**Step 1: Write failing webview asset assertions**

Update `schematicAssets.test.ts` to require imports and calls for
`layoutSchematic`, rendered core segments, and junction cells. Assert the
source no longer contains `networkPairs`, midpoint `trunkX`, a `bottom` port
group, or `deriveFeedbackRoutes`.

Run:

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicAssets.test.js
```

Expected: FAIL on the new source assertions.

**Step 2: Replace webview-local layout and routing**

Import `layoutSchematic` from `@veriflow/schematic-core`. Supply a Canvas-based
text measurer using the actual schematic font. For every rendered node, use
the exact bounds and pin anchors from the render model.

Render each canonical route segment exactly once as an X6 edge with a point
source and target. All segment cells carry the same network object ID so
selection, source navigation, search, and accessibility continue to operate at
network level. Render junctions as fixed, non-interactive circles above edges
and below modules. Ordinary bends receive no node.

Retain the existing direction marker only on a final segment that terminates at
a load pin. Shared trunks, junction-to-junction segments, bidirectional
terminals, and ordinary bends have no arrowhead.

**Step 3: Keep interactions stable**

Update selection expansion so selecting any segment highlights every segment
and junction for that network. Preserve double-click source reveal, keyboard
navigation, search descriptions, minimap inclusion, and label placement.

**Step 4: Build and run focused tests**

```bash
npm run build:web
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicAssets.test.js
node veriflow-vscode/out/test/webDistAssets.test.js
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
```

Expected: PASS. Inspect `web-dist/schematic/index.js` only through existing
generated-asset tests; do not commit generated web assets.

**Step 5: Commit the renderer migration**

```bash
git add packages/schematic-webview veriflow-vscode/src/test
git commit -m "feat: render shared schematic routes in x6"
```

### Task 11: Add Column-Snapped Dragging and Complete Host Integration

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `veriflow-vscode/src/schematic/layoutStore.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/test/schematicLayout.test.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`
- Modify: `veriflow-vscode/src/test/schematicIntegration.test.ts`
- Modify: `veriflow-vscode/src/test/schematicEditorProvider.test.ts`

**Step 1: Write failing drag-to-placement tests**

Test pure snapping first: dropping before a column midpoint keeps the current
column; crossing it selects the adjacent column; Y selects a stable insertion
order and offset. Test that input/output/inout boundary nodes cannot change
their required boundary.

Add protocol tests for the semantic placement payload and integration tests
showing a saved manual placement survives refresh.

**Step 2: Update the webview drag lifecycle**

During drag, move only the preview node. On drag completion, call the core
snapping helper, update semantic placement, recompute the full render model,
and save the normalized placement. Debounce persistence as today. Recompute
the full graph initially; do not add incremental routing caches before a
performance test requires them.

**Step 3: Remove obsolete host layout algorithms**

Delete Dagre layout, overlap pushing, fixed absolute-coordinate merging, and
`deriveFeedbackRoutes` from `layoutStore.ts`. Keep only storage, migration,
viewport state, and thin calls into core placement. Remove `@dagrejs/dagre`
from the extension and schematic-webview dependencies and update the lockfile.

**Step 4: Run all schematic tests and commit**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicLayout.test.js
node veriflow-vscode/out/test/schematicProtocol.test.js
node veriflow-vscode/out/test/schematicIntegration.test.js
node veriflow-vscode/out/test/schematicEditorProvider.test.js
npm test --workspace @veriflow/schematic-core
git add packages/schematic-webview veriflow-vscode package.json package-lock.json
git commit -m "feat: snap schematic editing to layout columns"
```

### Task 12: Verify Packaging, Visual Geometry, and Remove Compatibility Debt

**Files:**
- Modify: `scripts/build-web.mjs`
- Modify: `scripts/build-vscode.mjs`
- Modify: `veriflow-vscode/src/test/vsixPackaging.test.ts`
- Modify: `veriflow-vscode/src/test/rootWatch.test.ts`
- Modify: `README.md`
- Modify: `veriflow-vscode/README.md`
- Delete: `veriflow-vscode/src/schematic/graphModel.ts` only if all imports use the package
- Modify: `docs/plans/2026-08-09-schematic-arch-design-design.md` only for verified implementation notes

**Step 1: Add failing clean-build and package-boundary checks**

Require the root clean build to build `@veriflow/schematic-core` before
bundling the webview. Extend VSIX assertions so the package source is not
shipped accidentally and only required compiled/runtime assets are included.
Add a boundary assertion that no shared core source imports VS Code, Electron,
X6, or the webview package.

**Step 2: Fix build ordering and package contents**

Make `build:shared` include schematic core after HDL core. Ensure standalone
`npm run build:web` builds schematic core before esbuild resolves its public
exports. Keep generated `dist`, `dist-test`, `web-dist`, and extension media
out of source control.

Remove the graph-model compatibility shim only after `rg` confirms no product
imports remain. Do not remove a shim merely to satisfy aesthetics while a
consumer still needs it.

**Step 3: Add adversarial geometry fixtures**

Add deterministic core fixtures for:

- long labels and many pins;
- unequal-width nodes in adjacent columns;
- at least three networks competing for one channel;
- fan-out with a three-direction junction;
- perpendicular different-net crossings;
- a feedback loop on both top and bottom lanes;
- disconnected islands and an empty module.

Run the core tests, then use the existing Electron-capable schematic preview
or a minimal preview harness to capture desktop and narrow viewport
screenshots. Assert canvas pixels are nonblank and programmatically verify
that rendered label bounds, node bounds, and segment bounds do not overlap in
forbidden ways. Do not rerun unrelated manual waveform tests.

**Step 4: Update concise user documentation**

Document automatic left-to-right columns, side-only pins, orthogonal routing,
feedback lanes, column-snapped dragging, and the Relayout command. Do not
document `.ad` authoring yet because it is outside this phase.

**Step 5: Run the complete verification gate**

```bash
npm test --workspace @veriflow/schematic-core
npm run typecheck:shared
npm run build
npm test
npm run verify:generated
git diff --check
```

Expected: all commands exit 0; core routing properties pass; all existing Node
CLI and VS Code tests remain green; no generated artifacts are staged.

**Step 6: Commit the completed first phase**

```bash
git add package.json package-lock.json packages/schematic-core \
  packages/schematic-webview scripts veriflow-vscode README.md docs
git commit -m "feat: complete shared schematic layout and routing"
```

## Completion Criteria

- `@veriflow/schematic-core` is a published, host-neutral workspace package.
- Semantic `GraphPin` has no bottom or renderer-side property.
- Existing HDL schematics place inputs left, outputs right, and modules in
  deterministic columns.
- Cross-column normal routes are obstacle-free orthogonal paths with no
  different-net collinear overlap.
- Feedback uses top/bottom outer lanes.
- Same-net shared geometry is rendered once and branch dots obey the
  three-direction rule.
- Manual movement snaps to columns and persists semantically.
- X6 contains no independent midpoint routing logic.
- Dagre is removed from the schematic path.
- Full Node, VS Code, build, and packaging gates pass.
- The worktree is ready for the follow-up `.ad` model/export plan.

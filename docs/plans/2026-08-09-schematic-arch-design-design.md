# Schematic Layout, Routing, and Arch Design

## Summary

VeriFlow will replace the current Dagre-coordinate and per-edge X6 routing
with a host-neutral TypeScript schematic core. The core will normalize pins,
place modules in left-to-right columns, allocate routing channels, produce
obstacle-free orthogonal network trees, simplify geometry, and derive
junctions. X6 will render the computed result rather than decide routes.

The same core will support two related workflows:

- Existing Verilog and SystemVerilog files remain inspectable schematics whose
  graph is derived from HDL.
- New `.ad` Arch Design files become the source of truth for visual module
  composition, interface connections, defaults, and deterministic RTL export.

The first generated language is Verilog-2001 with a `.v` extension.
SystemVerilog output is selectable through design or project configuration.
Node CLI and VS Code use the same model, validator, router, and exporter.

## Goals

- Lay out data flow from left to right in explicit module columns.
- Put every module input on the left and every output on the right.
- Infer a side for bidirectional or opaque pins from their network role; never
  place pins on the bottom edge.
- Keep pin order identical to the HDL declaration order.
- Use only horizontal and vertical wire segments.
- Route across non-adjacent columns with an `H-V-H-V-H` shape through clear
  horizontal corridors and column channels.
- Prevent different networks from sharing collinear segments and prevent all
  routes from crossing module bounds.
- Merge shared segments of one network into one geometry tree.
- Draw a junction dot only where one network has at least three incident
  directions. Ordinary bends and two-direction straight points have no dot.
- Recognize common interfaces, collapse their members into one connection,
  and preserve an expandable member view.
- Generate explicit, synthesizable defaults for undriven interface inputs.
- Author module-only top-level designs in `.ad` without rewriting hand-written
  HDL.

## Non-Goals

- Compatibility with the Vivado `.bd` file format.
- Importing arbitrary procedural RTL into an editable Arch Design.
- Reordering module pins to optimize crossings.
- Letting X6 automatic connectors define route geometry.
- Hiding generated default behavior from the user or representing defaults
  visually without generating equivalent RTL.
- Restoring any Python implementation or Python test path.

## Current State and Reference Lessons

The current graph builder assigns `bottom` to bidirectional pins. Dagre emits
absolute node coordinates with fixed rank and node separation. The webview
then expands every network into driver/load pairs, calculates one midpoint
trunk for each network, and creates separate X6 edges. This architecture has
no model for columns, obstacles, track occupancy, shared network trees, or
junction directionality. Fixed-character truncation also cannot guarantee
that text remains inside a node.

Vik-SchGen demonstrates useful column/channel concepts: explicit columns,
per-channel vertical tracks, horizontal track reservations, same-net trunk
reuse, route collapsing, and demand-based channel shrink. Its implementation
is not copied because it uses connectivity-oriented BFS placement rather than
directed HDL flow, routes many long connections around an entire column band,
builds multi-terminal nets from pairwise MST edges, and detects junctions by
point repetition. Those choices cause excess whitespace, long bypasses,
duplicate geometry, and false junction dots.

## Package and Product Boundaries

Add a host-neutral `@veriflow/schematic-core` package. It may depend on shared
HDL model packages but must not import `vscode`, Electron, DOM APIs, X6, or a
product entry point. Its public responsibilities are:

```text
@veriflow/schematic-core
  graph/          normalized schematic graph and endpoint roles
  interfaces/     protocol schemas, recognition, and bundle matching
  layout/         columns, ordering, sizing, and semantic placement
  routing/        corridors, channels, tracks, network trees, junctions
  arch-design/    .ad schema, validation, migration, and serialization
  export/         deterministic Verilog/SystemVerilog generation
```

`@veriflow/schematic-webview` owns browser rendering and interaction. The VS
Code extension owns document lifecycle, workspace indexing, navigation, and
custom-editor integration. The Node CLI owns commands and filesystem output.
Both products call the same validation and export APIs.

## Layout and Rendering Data Flow

```text
SchematicGraph or ArchDesign
  -> normalize endpoint roles and pin sides
  -> recognize and collapse interface bundles
  -> build directed module hypergraph
  -> condense strongly connected components
  -> assign columns and boundary constraints
  -> retain declaration-order pins and order nodes within columns
  -> measure text and calculate node bounds
  -> plan abstract routing tracks
  -> size columns, channels, rows, and feedback margins
  -> realize final coordinates once
  -> merge and simplify network geometry
  -> derive junctions and labels
  -> SchematicRenderModel
  -> X6 rendering
```

`SchematicRenderModel` contains columns, node bounds, pin anchors, routing
channels, merged network segments, interface routes, junctions, and labels.
Rendering a network may require several X6 cells for selection and hit testing,
but their vertices come only from the core and all cells share one network ID.

## Pin Normalization and Node Sizing

The source graph retains semantic roles: `driver`, `load`, or `bidirectional`.
Pin side is a derived layout property. Loads are placed on the left and drivers
on the right. A bidirectional or opaque endpoint is placed according to its
observed role in the connected network. Ambiguous endpoints use a deterministic
fallback based on source order and the inferred direction of their peer nodes.

Pins on each side remain in declaration order. No crossing optimizer may
reorder them.

Node height is the title area plus the larger of the left and right pin counts
times the pin row height, with grid-aligned padding. Node width accounts for
the title, subtitle, left labels, right labels, and a minimum center gap. A
text-measurement interface keeps the core host-neutral: the browser supplies
Canvas measurements and tests supply deterministic metrics. Widths have a
maximum; text beyond it is ellipsized, clipped to the node, and exposed through
a tooltip. Text and labels may never extend outside node bounds.

## Column Placement

Top-level inputs occupy the left boundary column. Top-level outputs and inout
I/O cells occupy the right boundary column. Internal modules are ranked from
driver-to-load relationships. Strongly connected components are condensed
before longest-path rank assignment so feedback does not destabilize columns.

Automatic layout assigns every node a column and a stable row order. Manual
dragging remains column constrained: vertical movement is free, while crossing
a column midpoint changes the node's column and snaps it to that column on
drop. Top-level boundary nodes cannot change sides.

Persist semantic placement rather than raw coordinates:

```text
node ID -> column assignment, row order, vertical offset, user-positioned flag
```

Viewport, collapsed interfaces, and selection are presentation state. Absolute
coordinates are regenerated when module sizes or channel demand change.
Existing schema-v1 absolute layouts may seed row order once, then are saved in
the new schema.

## Channel and Corridor Routing

The router plans in abstract track indices before choosing pixel coordinates.
Vertical channels occupy the gaps between module columns. Horizontal corridors
are obstacle-free bands through one or more column ranges. Each reservation
records orientation, track, covered interval, and network ID.

Different networks cannot reserve overlapping collinear intervals. Perpendicular
crossings are allowed and do not imply connectivity. A network may reuse its
own reservation; reused intervals are merged into one segment before rendering.

An adjacent-column connection is direct horizontal when endpoint heights align
and the segment is clear. Otherwise it uses `H-V-H`. A connection spanning one
or more intermediate columns uses `H-V-H-V-H`: horizontal escape into the
source channel, vertical movement onto an available corridor, a horizontal
cross-column trunk that intersects no module, vertical movement in the target
channel, and horizontal entry into the target pin.

If no internal corridor is valid, the router allocates an outer corridor.
Feedback networks always use outer top or bottom lanes. The selected side
minimizes added length and lane demand. Every endpoint still leaves a left or
right pin horizontally; feedback never attaches to a module's top or bottom.

Channel width and outer margin derive from actual track counts:

```text
edge escape margin + track count * track spacing + safety margin
```

There is no route-coordinate shrink pass. Abstract tracks are planned first,
then final node and route coordinates are realized together.

## Network Trees and Junctions

Route one complete network rather than independent driver/load edges. Build a
rectilinear tree incrementally from deterministic terminal order, preferring
existing same-net trunks when cost is equal. Multi-driver and bidirectional
networks remain one undirected geometry tree even though individual endpoints
retain their electrical roles.

After routing, remove zero-length segments, merge collinear adjacent segments,
split segments at actual branch points, and deduplicate identical same-net
geometry. Derive incident direction sets at every resulting point:

```text
L + R       straight point, no dot
L + U       bend, no dot
L + R + U   junction dot
L + R + U + D junction dot
```

Only directions from the same network participate. A perpendicular crossing
between different networks has no dot.

## Interface Recognition

Interface schemas are declarative data consumed by one recognition engine.
Built-in schemas cover AXI4, AXI4-Lite, AXI-Stream, APB3/4, and AHB-Lite.
Projects may add custom schemas through `schematic.interface_protocols` in the
project JSON. Custom schemas have separate names and do not silently override
built-ins.

Recognition first strips the longest known signal suffix, leaving the exact
instance-local interface key. For example, `m_axi_00_awaddr` belongs to
`m_axi_00`, while `m_axi_01_awaddr` belongs to `m_axi_01`. The `m_` or `s_`
prefix is evidence for the role but does not decide the protocol. The observed
members and directions distinguish AXI4, AXI-Lite, and a generic AXI-family
fallback.

Incomplete member sets are still bundled and do not produce a warning merely
for being incomplete. A collapsed bundle appears as one interface pin and one
thicker master-to-slave connection. The direction is semantic for the bundle;
reverse handshake and response member signals keep their true electrical
directions. Interfaces are collapsed by default and may be expanded. Expansion
restores member pins in HDL declaration order and reroutes their real networks.
The collapsed state is persisted per interface.

## Defaults and Adaptation

Every protocol member may define behavior for an existing receiver input that
has no driver. Effective defaults use this precedence:

```text
connection override
  > project protocol rule
  > built-in protocol rule
```

Rules distinguish constants, width-derived values, protocol-derived values,
open outputs, and required inputs with no valid default. Examples include
`WLAST=1` for a single-beat adaptation and `AWLEN=0`. A default is generated
only when the receiving port exists and lacks a source. A port absent from the
receiver creates no logic; an extra sender output remains unused.

Collapsed interfaces do not draw constant nodes or default branches. Selecting
an interface shows every effective default, its origin, and its generated
expression. Generated RTL always contains the explicit tie-off or adapter
connection. The UI must never imply a default that the exporter does not emit.

## Arch Design Format

`.ad` means Arch Design and is not Vivado-compatible. It is readable JSON with
a format discriminator and schema version:

```json
{
  "format": "vik-veriflow.arch-design",
  "schemaVersion": 1,
  "module": "soc_top",
  "ports": [],
  "instances": [],
  "connections": [],
  "interfaceConnections": [],
  "defaults": {},
  "export": {},
  "presentation": {}
}
```

The semantic section stores top-level ports, module instances, parameter
overrides, scalar connections, interface connections, and default overrides.
The presentation section stores columns, rows, offsets, collapsed state, and
viewport. A semantic fingerprint excludes presentation, so moving or zooming
does not stale generated RTL.

Existing `.v/.sv` schematics remain inspection views. `.ad` is the authoring
format for adding instances, creating scalar or interface connections, and
exporting a generated module. It deliberately supports module instantiation
and port connectivity rather than arbitrary procedural HDL.

## Top-Level Ports and Inout Cells

An input top-level port is a left-boundary node with one internal output. An
output top-level port is a right-boundary node with one internal input. Their
generated connections are explicit continuous assignments:

```verilog
assign internal_input_net = input_port;
assign output_port = internal_output_net;
```

An inout top-level port is a right-boundary special node with internal inputs
`<name>_o` and `<name>_t`, plus internal output `<name>_i`. The output value and
tri-state control flow left to right. The readback path is routed as an outer
feedback network.

`_i` and `_o` equal the inout port width. `_t` accepts either width 1 for
whole-port control or the exact port width for per-bit control. Other widths
are invalid. An unconnected `_t` defaults to 1, leaving the port high impedance.

Scalar control generates:

```verilog
assign gpio = gpio_t ? {GPIO_WIDTH{1'bz}} : gpio_o;
assign gpio_i = gpio;
```

Per-bit control generates a Verilog-2001 `genvar` and named `generate` loop
with one conditional continuous assignment per bit.

## RTL Export

`.ad` is the source of truth and generated RTL is disposable. The default
language is Verilog-2001 and the default output for `soc_top.ad` is the sibling
`soc_top.v`. A design or project setting may select SystemVerilog, producing
`soc_top.sv`. CLI flags have highest precedence:

```text
CLI --language
  > design export.language
  > project arch_design.language
  > verilog
```

Verilog output uses `wire`, explicit named port and parameter mappings,
continuous assignments, and traditional `generate/genvar` syntax. It avoids
SystemVerilog-only syntax. The SystemVerilog mode stays within the conservative
subset unless a requested feature requires otherwise.

Generated files include their source path, schema version, and semantic
fingerprint. Export writes a temporary file and atomically replaces the target.
Automatic replacement is permitted only when the existing target has a
matching VeriFlow generation marker. A same-name hand-written file causes an
error and is never silently overwritten.

VS Code exposes Validate and Export RTL commands. The CLI exposes:

```text
veriflow ad validate design.ad
veriflow ad export design.ad
veriflow ad export design.ad -o generated/design.v
```

Export is explicit during editing. Build and simulation check the semantic
fingerprint and automatically export stale or missing generated RTL. Layout-only
changes do not trigger export.

## Validation and Failure Behavior

Validation reports schema errors, unresolved or ambiguous module definitions,
unknown ports, invalid parameter values, width mismatches, multiple input
drivers, invalid inout `_t` widths, unsafe default expressions, and required
undriven inputs without a default. Incomplete recognized interfaces alone are
not an error or warning.

Invalid intermediate edits remain visible in the `.ad` editor with localized
diagnostics. Export is blocked until semantic errors are resolved. A failed
export leaves the previous generated file untouched. Unknown schema versions
open read-only with a migration message rather than being rewritten.

## Verification

All new tests are Node/TypeScript tests. No Python suite is restored.

Layout and routing tests assert deterministic output, orthogonal segments,
module avoidance, no different-net collinear overlap, correct adjacent and
cross-column segment patterns, outer-only feedback, same-net segment merging,
and junction direction rules. Text tests use a deterministic measurer and
assert that every visible label lies inside its node bounds.

Interface tests cover multiple numbered interfaces on one module, protocol
variants under misleading prefixes, incomplete bundles, declaration-order
expansion, master/slave inference, project schemas, and default precedence.

Arch Design golden tests cover scalar connections, parameters, input/output
ports, scalar and per-bit inout, interface defaults, generated-file markers,
language selection, and collision refusal. Generated `.v` files are parsed by
the shared HDL parser and compiled with Icarus Verilog when available.

Electron/Playwright tests cover column snapping, cross-column dragging, route
recalculation, bundle expansion, connection creation, default inspection,
validation errors, and RTL export. Screenshots and canvas bounds checks cover
desktop and constrained viewports.

## Delivery Sequence

1. Extract the shared graph model and add layout/routing characterization
   fixtures for current HDL schematics.
2. Implement pin normalization, column placement, track planning, network-tree
   routing, simplification, junctions, and semantic layout persistence in
   `@veriflow/schematic-core`.
3. Replace X6-computed routing in the existing `.v/.sv` schematic with the
   shared render model and complete graphical verification.
4. Add the `.ad` schema, parser, migration boundary, validator, top-level port
   model, defaults, and deterministic Verilog/SystemVerilog exporter.
5. Add `veriflow ad validate|export` and build/simulation stale-output handling.
6. Add the `.ad` custom editor: instance palette, parameters, ports, scalar
   connections, column-constrained dragging, validation, and export.
7. Add protocol schemas, recognition, collapsed and expanded interface pins,
   interface connections, default inspection, and project-defined protocols.
8. Complete Electron/Playwright workflows, release packaging, and user
   documentation.

Each stage is independently testable and must leave existing HDL inspection,
Node CLI behavior, and VS Code packaging operational.

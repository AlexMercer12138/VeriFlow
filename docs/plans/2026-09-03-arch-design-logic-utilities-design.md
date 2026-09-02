# Arch Design Logic Utilities

## Summary

Arch Design keeps undriven-input defaults as resolver and RTL-export semantics,
but no longer projects those defaults as constant boxes on the canvas. Authors
can instead add explicit, persistent Logic Utility nodes for constants and
common combinational operations when the top-level design needs real glue
logic.

Logic Utilities are first-class `.ad` objects. They are not synthetic HDL
module instances and do not depend on the workspace module catalog. Generated
Verilog and SystemVerilog use continuous assignments rather than helper
functions or generated utility modules.

## Goals

- Hide every derived default source from the graph while retaining its current
  validation and RTL behavior.
- Keep an undriven instance or Logic Utility input implicitly tied to `0`.
- Keep an undriven top-level inout tri-state control implicitly tied to `1`.
- Add explicit, editable Constant, gate, mux, concatenation, slicing,
  replication, extension, and reduction nodes.
- Export all Logic Utilities as deterministic, synthesizable Verilog-2001
  continuous assignments.
- Preserve schema-v1 compatibility and reject unsupported newer documents
  without silently dropping their utilities.

## Non-Goals

- Arbitrary expressions or procedural RTL on the canvas.
- Arithmetic, comparison, shifting, registers, latches, or clocked primitives.
- Replacing ordinary HDL modules with graphical primitives.
- Inferring a utility's persisted configuration from its current connections.
- Generating a reusable RTL library of utility modules.

## Document Model

The `.ad` schema advances to version 2 and gains a `logic` array. Each entry is
a discriminated Logic Utility with a plain Verilog identifier `name`, an
`operation`, and the configuration required to define stable pins and widths.
Scalar connections gain a `logic` endpoint containing the utility name and pin
name. Logic Utility names must not collide with instance or top-level port
names, keeping endpoint defaults and Inspector labels unambiguous.

The operation set is:

- `constant`: a safe constant expression and output width.
- `not`: one input and one output of the configured width.
- `and`, `or`, `xor`, `nand`, `nor`, `xnor`: two to eight equal-width inputs
  and one equal-width output.
- `mux`: two equal-width data inputs, a one-bit select, and one data output.
- `concat`: two to eight independently sized inputs and one derived-width
  output. `in0` is the most-significant part.
- `slice`: one configured-width input, inclusive `msb` and `lsb`, and a
  derived-width output.
- `replicate`: one configured-width input, a positive repetition count, and a
  derived-width output.
- `zero-extend` and `sign-extend`: configured input and output widths.
- `reduce-and`, `reduce-or`, and `reduce-xor`: one configured-width input and a
  one-bit output.

Widths reuse `ArchDesignWidth`, so numeric and symbolic widths follow the same
representation as top-level ports. Derived widths are computed by the resolver
and are not redundantly persisted. Schema-v1 documents parse with an empty
Logic Utility list; schema-v2 documents open read-only in older builds instead
of being rewritten with the `logic` field removed.

## Resolution And Validation

The resolver projects every utility pin as an ordinary endpoint target. Utility
outputs are drivers; utility inputs are loads. Existing connection rules then
apply without a second graph or net model: unknown endpoints, duplicate
endpoints, multiple drivers, direction errors, and width mismatches use the
normal Arch Design diagnostics.

Undriven utility inputs receive the same `implicit-zero` effective default as
undriven instance inputs. Explicit connection and design defaults retain their
current precedence. Invalid utility configuration produces localized
diagnostics and blocks RTL export. Numeric slice bounds must satisfy
`msb >= lsb >= 0`; counts and input counts must be within their supported
ranges; extend output widths must not be smaller when the comparison is
statically decidable. Symbolic relationships remain expressions and are
checked by downstream HDL tooling when they cannot be proven locally.

Deleting a utility removes every scalar connection endpoint that refers to it,
removes empty connections, clears its endpoint defaults, and drops its saved
placement. Renaming updates the same references atomically.

## Graph Presentation

Graph projection stops creating constant nodes for `effectiveDefaults` and for
interface defaults. This applies uniformly to implicit zero, implicit inout
tri-state control, explicit pin defaults, driverless-connection defaults, and
protocol defaults. Explicit driverless connections remain visible with their
real receiver endpoints even though their generated driver exists only during
RTL export.

User-created Logic Utilities are ordinary editable graph nodes. Constant is a
visible source node; gates and transformations show named input and output
pins. Utilities participate in placement, routing, search, selection,
Inspector editing, connection mode, rename, and delete behavior. Their graph
IDs use a dedicated prefix so they cannot collide with instance or port graph
IDs.

The toolbar adds a **Logic Utility** action with a component icon. Its dialog
first selects an operation and then shows only the relevant configuration
fields. Names are proposed as `u_<operation>_<number>` using the lowest
available suffix. The Inspector permits later name and configuration edits
through one validated `updateLogic` edit.

## RTL Export

Logic Utilities emit internal wires and continuous assignments. This is more
direct than Verilog functions, introduces no additional scope or declaration
ordering constraints, and gives synthesis tools the original combinational
expression.

Representative expressions are:

```verilog
assign gate_y = gate_in0 & gate_in1;
assign mux_y = mux_select ? mux_in1 : mux_in0;
assign concat_y = {concat_in0, concat_in1};
assign slice_y = slice_in[MSB:LSB];
assign replicate_y = {COUNT{replicate_in}};
assign zext_y = {{(OUT_WIDTH-IN_WIDTH){1'b0}}, zext_in};
assign sext_y = {{(OUT_WIDTH-IN_WIDTH){sext_in[IN_WIDTH-1]}}, sext_in};
assign reduction_y = ^reduction_in;
```

Unconnected inputs substitute their effective default directly into the
expression. Connected pins use the existing allocated connection nets.
Unconnected outputs may remain unused. The exporter preserves deterministic
declaration and assignment order and allocates collision-safe identifiers with
the existing RTL binding machinery.

## Error Handling And Compatibility

- Invalid utility edits are rejected before document replacement.
- A parsed invalid utility reports a path beneath `$.logic[index]`.
- Export remains all-or-nothing and never publishes partial RTL.
- Existing schema-v1 documents require no migration action from the user.
- Presentation-only edits remain excluded from the semantic fingerprint;
  adding or changing a utility changes it.
- The VS Code command boundary validates utility edits before passing them to
  the core reducer.

## Verification

Implementation follows test-driven development. Core tests cover schema-v1
compatibility, schema-v2 parsing and deterministic serialization, reducer
cascades, endpoint resolution, every operation's pins and widths, default
precedence, graph projection, and RTL golden output. A focused regression
asserts that no derived default creates a graph node while an explicit Constant
does.

Webview and host tests cover command normalization, the dynamic Logic Utility
dialog, automatic names, Inspector updates, connection creation, deletion, and
layout persistence. Export fixtures exercise both Verilog and SystemVerilog;
generated Verilog is compiled with Icarus when available. Existing Arch Design,
CLI, VS Code extension, web asset, and release tests remain green.

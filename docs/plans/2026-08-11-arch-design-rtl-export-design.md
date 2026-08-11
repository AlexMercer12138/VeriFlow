# Arch Design RTL Export Design

## Scope

This phase adds deterministic Verilog-2001 and conservative SystemVerilog text
generation to the host-neutral `@veriflow/schematic-core/arch-design` subpath.
The exporter accepts a normalized `ArchDesign`, the same module-definition
catalog used by validation, and optional language/source-path metadata. It
returns either immutable generated text and marker metadata or immutable,
path-aware diagnostics. It performs semantic resolution itself so callers
cannot accidentally export a design they validated against a different
catalog snapshot.

The core does not read or write files. Atomic replacement, output-path
selection, collision refusal, and stale-file handling remain responsibilities
of the later Node CLI and VS Code host adapters. Interface connections remain
blocked by the existing `AD_INTERFACE_UNSUPPORTED` diagnostic until protocol
recognition is implemented. Existing `.v` and `.sv` schematic inspection is
unchanged.

## Public API

`exportArchDesignRtl(design, definitions, options)` returns a discriminated
result. A successful result contains `status: "generated"`, the effective
language, conventional extension, semantic fingerprint, generation marker,
and complete RTL text. A rejected result contains `status: "invalid"` and the
sorted semantic diagnostics. The language precedence inside the core is
explicit option, then `design.export.language`, then `verilog`; project and CLI
configuration are resolved by the host before calling the core.

The marker is one machine-readable comment containing schema version,
fingerprint, and language. A second comment stores the source path as a JSON
string so newlines and other control characters cannot inject generated RTL.
`parseArchDesignRtlMarker(text)` lets future hosts decide whether an existing
target is owned by VeriFlow without duplicating marker parsing.

The fingerprint is computed with the effective language substituted into the
semantic design. Therefore a CLI language override changes the fingerprint,
while presentation and output-path edits do not.

## RTL Mapping

Top ports and instances remain in declaration order. Instance parameter
overrides follow definition parameter order, and named instance port mappings
follow definition port order. Number and raw string parameter values are
rendered deterministically; booleans become `1'b1` or `1'b0`. Every resolved
instance port is emitted explicitly. Unconnected outputs and bidirectional
ports use empty named mappings, while an unconnected receiver with an effective
default receives that expression directly.

Every scalar connection receives a generated internal net name. Names start
from `__vf_net_<connection>` and use a stable numeric suffix when they collide
with any top port, instance, connection-derived net, genvar, or generate-block
identifier. This allows a network and top port to share the common name
`result` without an illegal redeclaration. Network widths prefer the first
renderable definite source width, then the first renderable endpoint width;
known widths become `[N-1:0]`, symbolic widths become `[(EXPR)-1:0]`, and a
fully unknown or empty connection is emitted as a scalar net.

Top-level inputs drive their connected internal nets with continuous assigns.
Top-level outputs are continuously assigned from their net or effective
default. A driverless connected network is assigned once from the resolver's
single selected default source, so all receivers share identical generated
behavior.

## Inout Generation

An inout port exposes the resolver's `i`, `o`, and `t` endpoints. If `i` is
connected, its internal net is assigned from the physical port. The physical
port is driven from the `o` and `t` bindings, using effective defaults where
either receiver is unconnected. An unconnected `t` therefore uses the existing
implicit `1'b1` default and leaves the port high impedance.

Scalar control emits one assignment:

```verilog
assign gpio = gpio_t ? {8{1'bz}} : gpio_o;
assign gpio_i = gpio;
```

When the `t` connection has full-port width, the exporter emits a traditional
Verilog-2001 `genvar` and named `generate` loop with one conditional assignment
per bit. Width-one ports always use the scalar form. Generated loop identifiers
use the same collision-safe allocator as network names.

## Failure And Verification

Any semantic diagnostic blocks generation and no partial RTL is returned.
This includes unresolved modules, duplicate declarations, unknown endpoints,
multiple drivers, unsafe defaults, undriven receivers, invalid inout control
widths, and currently unsupported interface connections. The exporter snapshots
all values it uses through the existing resolver and returns deeply frozen
results.

Golden tests cover empty modules, ordered ports and instances, parameter
overrides, fanout and driverless defaults, same-name port/network avoidance,
scalar and vector inout, both languages, markers, hostile source paths,
diagnostic blocking, deterministic repeated output, and caller mutation.
Generated Verilog is compiled with Icarus when it is available; all required
tests remain Node/TypeScript tests and no Python test path is restored.

# Arch Design Interface Protocols Design

## Summary

Arch Design gains one complete interface workflow driven by declarative JSON
protocol definitions. Built-in AXI4, AXI-Stream, APB, and AHB-Lite protocols
use the same schema, parser, recognizer, connection resolver, default rules,
graph projection, and RTL exporter as project-defined protocols. No built-in
protocol receives a TypeScript-only recognition path.

The phase includes protocol loading and validation, automatic interface
recognition, role inference and overrides, collapsed and expanded rendering,
strict one-to-one interface authoring, explicit defaults for missing receiver
members, top-level interface ports, and Verilog/SystemVerilog export. AXI4-Lite
is treated as an incomplete AXI4 interface rather than a separate protocol.

## Protocol Files And Loading

Each protocol is an independent JSON document with a versioned header, stable
ID, display name, separator, member declarations, and recognition groups:

```json
{
  "format": "veriflow-interface-protocol",
  "schemaVersion": 1,
  "id": "amba.axi4",
  "name": "AXI4",
  "separator": "_",
  "members": [
    {
      "name": "awaddr",
      "direction": "master-to-slave",
      "default": "0"
    },
    {
      "name": "awready",
      "direction": "slave-to-master",
      "default": "1'b0"
    }
  ],
  "recognitionGroups": [
    ["awaddr", "awvalid"],
    ["wdata", "wvalid"],
    ["araddr", "arvalid"],
    ["rdata", "rvalid"]
  ]
}
```

Member matching is case-insensitive. The protocol owns its separator, while
the original HDL spelling is retained for instance bindings and display. The
recognizer removes the longest complete member suffix and uses the remaining
text as the exact interface key. Thus `M_AXI_00_AWADDR` resolves to interface
`M_AXI_00` and member `awaddr` when the separator is `_`.

An interface is created only after every member in at least one recognition
group is present. Once recognized, every other member may be absent. If more
than one protocol matches, the resolver compares recognition-group
specificity, total matched members, and the declared protocol priority. An
unresolved tie is an ambiguity diagnostic rather than an arbitrary choice.

Built-in JSON resources ship with `@veriflow/schematic-core`. The initial set
is AXI4, AXI-Stream, APB, and AHB-Lite. AXI4-Lite is recognized as incomplete
AXI4. Built-in protocols exclude clock and reset signals; project protocols may
include them explicitly when needed.

Projects reference protocol files through
`schematic.interface_protocols`. Paths are resolved relative to the project
file. A project protocol whose `id` matches a built-in protocol replaces the
entire built-in definition. Definitions are never merged field by field. The
effective source and override relationship remain available to diagnostics
and the Inspector.

Invalid JSON, unknown versions, duplicate members, recognition groups that
refer to unknown members, and unsafe default expressions produce path-aware
diagnostics. An invalid project definition does not partially replace a valid
built-in definition.

## Recognition And Roles

Recognition produces host-neutral resolved interface values derived from the
module catalog and effective protocol catalog:

```ts
type ResolvedInterface = Readonly<{
    endpoint: Readonly<{ kind: 'instance'; instance: string }>;
    key: string;
    protocol: string;
    role: 'master' | 'slave' | 'unknown';
    roleSource: 'inferred' | 'override' | 'unknown';
    members: readonly Readonly<{
        member: string;
        port: string;
        direction: 'master-to-slave' | 'slave-to-master';
        width: WidthValue;
    }>[];
}>;
```

Master and Slave roles are inferred only from the relation between each
protocol member's relative direction and the actual HDL port direction. Names
such as `m_axi` and `s_axi` are never role evidence. An interface remains
recognized when there is insufficient directional evidence; it receives the
`unknown` role and must be fixed through the Inspector before connection.

Recognition results are recalculated and are not copied into the Arch Design.
Only a user-selected protocol or role is persisted as an interface override.
This prevents the design source from duplicating module declarations while
preserving deliberate choices when inference is ambiguous.

## Arch Design Model

Schema-v1 is extended with top-level interface ports and interface overrides.
The existing interface connection section is normalized into typed one-to-one
connections:

```json
{
  "interfacePorts": [
    {
      "name": "s_axi",
      "protocol": "amba.axi4",
      "role": "slave",
      "memberPrefix": "s_axi",
      "members": [
        { "member": "awaddr", "width": 32 },
        { "member": "awvalid", "width": 1 },
        { "member": "awready", "width": 1 }
      ]
    }
  ],
  "interfaceOverrides": {
    "dma_0.m_axi_00": {
      "protocol": "amba.axi4",
      "role": "master"
    }
  },
  "interfaceConnections": [
    {
      "name": "control_axi",
      "master": {
        "kind": "instance",
        "instance": "dma_0",
        "interface": "m_axi_00"
      },
      "slave": {
        "kind": "port",
        "port": "s_axi"
      },
      "defaults": {
        "wlast": "1'b1"
      }
    }
  ]
}
```

Top-level interfaces are declarations and therefore always persist. Their role
uses the external design meaning: a top-level Slave receives Master-to-Slave
members as RTL inputs and sends Slave-to-Master members as RTL outputs. The
resolver treats the boundary as the external peer's proxy when connecting it
inside the graph.

Protocols do not declare widths or width parameters. Instance interface
members always use the actual widths parsed from HDL. A top-level interface is
created only by promoting a recognized module interface, which snapshots that
interface's currently present members, declaration order, and concrete widths
into the Arch Design. Disconnecting it keeps the snapshot stable. Reconnecting
to a different interface reports ordinary member and width diagnostics rather
than silently changing the public RTL. The Inspector provides an explicit
resynchronize action that replaces the snapshot from the current peer.

Each interface connection has exactly one Master and one Slave. Fan-out,
address decoding, and arbitration require an explicit interconnect module.
Every recognized member port owned by an interface connection is exclusive:
it cannot also occur in a scalar connection or another interface connection.
The editor rejects a conflicting operation and lists occupied members;
externally edited conflicting JSON remains intact but receives an error.

Rename and removal edits cascade through interface ports, overrides,
connections, and stable presentation IDs. A protocol change that invalidates
an existing connection reports diagnostics without silently deleting user
data. Interface collapsed state remains presentation-only and does not affect
the semantic fingerprint or generated RTL.

## Connection Expansion And Defaults

The core expands every interface connection into a shared member-level result
used by validation, graph projection, and RTL export. For each protocol member:

- If both ports exist, connect the actual sender output to receiver input.
- If only the sender exists, leave that output open.
- If only the receiver exists, use the connection override and then the
  effective protocol default.
- If both are absent, emit nothing.
- If a present receiver has neither a driver nor a default, report an error
  and block export.
- If actual directions disagree with the selected roles and protocol, report
  an error.
- If known widths differ, report a warning but permit export.

Defaults are restricted Verilog constant expressions and reuse the existing
safe-expression validator. A connection-level default overrides the effective
project or built-in protocol value. The Inspector shows the effective value,
its source, the inherited protocol value, and a restore action. An unconnected
interface endpoint may hold endpoint-level overrides for its undriven inputs.
Built-in defaults use Verilog-2001-compatible expressions because `.v` is the
default export; project defaults that require SystemVerilog are rejected when
the effective export language is Verilog.

Generated RTL does not insert opaque width adapters. The internal member net
uses the actual driver's width, and ordinary Verilog named-port connection
semantics perform truncation or extension at the receiver. Diagnostics state
the two widths and whether truncation or extension can occur.

## RTL Export

Interface export remains ordinary Verilog-2001 by default. SystemVerilog
output also uses scalar ports and named module bindings; this phase does not
generate SystemVerilog `interface` declarations.

Top-level interfaces expand deterministically using their member prefix,
protocol separator, and member names:

```verilog
module soc_top (
    input  wire [31:0] s_axi_awaddr,
    input  wire        s_axi_awvalid,
    output wire        s_axi_awready
);
```

Module instance bindings retain the module's original port spelling. Shared
internal member nets use collision-safe deterministic names. Missing receiver
members with defaults generate explicit constant bindings or assignments;
missing receivers generate no net. The export fingerprint includes every
effective protocol definition and interface semantic that can alter output,
but excludes collapsed state and other presentation data.

## Editor Experience

Recognized interfaces are collapsed by default. Module Slave interfaces
appear on the left and Master interfaces on the right. An unknown-role
interface uses its aggregate physical port evidence for temporary placement
and carries a visible unknown-role marker. Its role must be resolved in the
Inspector before connection.

Collapsed pins and routes are thicker than scalar signals and show the
interface key and protocol name. A connection drag is accepted only from a
Master to a Slave after protocol, role, member occupancy, and one-to-one rules
pass. Expanding an interface displays existing member pins in original HDL
declaration order. Expansion is for inspection; the interface connection stays
one indivisible authoring object.

Top-level interfaces reuse the top-level scalar port boundary shape. A colored
protocol-and-role label distinguishes them without inventing a second boundary
symbol. Top-level Slave interfaces remain on the left and Master interfaces on
the right, matching their external meaning.

Every module pin is independently selectable. Its Inspector shows instance,
original port name, direction, actual width, recognized interface membership,
and connection state. `Expose as top-level port` creates a scalar top-level
port with the same direction and width and connects it in one reducer edit.
The original port name is the proposed public name; a collision requires an
explicit replacement name. Existing scalar inout `_i`, `_o`, and `_t`
semantics remain unchanged.

A collapsed interface provides `Expose as top-level interface`. The operation
snapshots its actual members and widths, creates a same-role top-level
interface, and connects it atomically. When expanded, an individual member pin
may instead be exposed as an ordinary scalar top-level port. That member then
participates in scalar occupancy and prevents a whole-interface connection
until the conflict is removed. The generic Add Port dialog remains scalar-only;
AXI, APB, AHB, and custom top-level interfaces cannot be created without a real
module interface to define their concrete shape.

The Inspector exposes protocol, role and source, matched and absent members,
original HDL port names, peer connection, effective defaults and sources,
width warnings, collapsed state, role/protocol overrides, and restore actions.
Top-level interface selection also exposes the locked member list and an
explicit `Resynchronize from current connection` action.
Collapsed views hide constant nodes and member branches. Expanded views reveal
the real member networks and default constants so that the visible details
agree with exported RTL.

Ordinary selection, viewport movement, collapse toggles, and local rerouting
must not trigger a full document reload. A protocol or module-catalog refresh
rebuilds only when the resolved graph actually changes and preserves the
current selection whenever its semantic ID still exists.

## Package And Host Boundaries

`@veriflow/schematic-core/interfaces` owns protocol models, defensive parsing,
catalog construction, recognition, role inference, and connection expansion.
Built-in JSON files are package resources. The Arch Design resolver, graph
projector, and RTL exporter consume the effective protocol catalog and one
resolved interface result rather than reimplementing protocol behavior.

The Node CLI and VS Code extension own filesystem access only. Standalone Arch
Design commands load built-ins. Project-based CLI commands and VS Code load
the referenced files relative to the project and return the same core
diagnostics. The shared webview receives resolved display and edit models; it
does not parse protocols or HDL.

## Error Handling And Verification

Protocol errors are path-aware and identify the source file. Parser and loader
errors appear in CLI output, VS Code diagnostics, and the editor diagnostic
surface. Effective project overrides are visible informational provenance, not
warnings. Interface semantic errors block RTL export; width mismatches remain
warnings.

Implementation is test-driven across these boundaries:

- Protocol parser tests cover hostile input, schema diagnostics, members,
  recognition groups, safe defaults, and whole-definition overrides.
- Recognition tests cover multiple interfaces per module, case-insensitive
  suffixes, separators, longest suffixes, incomplete AXI4, role inference,
  role ambiguity, and protocol ambiguity.
- Arch Design tests cover top-level interfaces, overrides, one-to-one
  connections, member exclusivity, and rename/removal cascades.
- Semantic and RTL tests cover paired members, open sender outputs, receiver
  defaults, missing required defaults, direction errors, width warnings, and
  deterministic Verilog/SystemVerilog.
- Webview and Electron tests cover collapsed and expanded interfaces, colored
  top-level labels, interface drag connections, and Inspector default edits.
- CLI and VS Code tests cover shared project loading, diagnostics, validation,
  safe overwrite behavior, and protocol refresh without interaction resets.
- Packaging tests require built-in JSON resources in the schematic-core npm
  package, Node release, and VSIX.

No Python code or Python tests are introduced.

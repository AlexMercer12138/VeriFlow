# Arch Design Editor and Schematic UX

## Summary

The Arch Design editor will reuse the existing host-neutral schematic core and
X6 webview. Before editable `.ad` documents are added, the shared renderer will
gain a stable logical selection model, a right-side Inspector, stronger theme
contrast, explicit top-level port labels, and label-free network geometry.

These changes apply to both product modes:

- `.v` and `.sv` documents remain read-only inspection schematics.
- `.ad` documents own editable instances, ports, connections, defaults, and
  export settings.

The previously approved `.ad` schema, interface recognition, default handling,
top-level inout behavior, and Verilog-first export rules remain unchanged from
`docs/plans/2026-08-09-schematic-arch-design-design.md`.

## Visual Acceptance Criteria

### Top-Level Ports

Every top-level port node renders its semantic port name inside the node. The
name is visible even when the connected network has the same name. Input ports
remain on the left boundary; output and inout ports remain on the right.

Port labels use the same measured, clipped text path as module titles. Compact
boundary geometry may not suppress the label or place it outside the node.

### Network Labels

The canvas does not draw network names, label backgrounds, or label anchor
cells. Network names remain semantic data used by search, diagnostics,
selection, export, and the Inspector.

For compatibility, the current render-model label field may remain temporarily
as an empty deprecated field, but layout must not reserve bounds or routing
space for network labels. A later major API revision may remove that field.

### Network Selection

X6 Selection owns node selection and rubber-band node selection only. Network
selection is logical webview state keyed by network ID. Clicking any segment or
junction selects the whole network and applies selected stroke attributes to
all of its rendered segments and junctions.

Selected networks have no selection rectangle, bounding box, resize handle, or
translucent area fill. Clicking empty canvas clears network selection. Node
multi-selection and batch dragging continue to use selection boxes.

### Contrast

The webview defines explicit semantic color tokens for canvas, node fill, node
border, primary text, secondary text, pins, ordinary wires, selected wires,
and junctions. Tokens prefer VS Code high-contrast and widget variables before
falling back to fixed light/dark-safe colors.

Module and port boundaries use a stronger stroke than ordinary wires. Pin
circles and top-level direction accents remain visible against node fill.
Selected networks use the focus color and a larger stroke width. Disabled and
secondary text remain subordinate but readable.

## Shared Inspector

The schematic shell becomes a toolbar, a content row, and a status strip. The
content row contains a flexible canvas and a right-side Inspector approximately
280 pixels wide. The Inspector is open by default and can be collapsed with an
icon button. It is part of the webview rather than a VS Code native View so its
selection always belongs to the active editor panel.

Read-only schematic properties are derived locally from the published graph:

- Network: name, adapter label, width, driver endpoints, load endpoints, and
  bidirectional endpoints.
- Instance: instance name, module type, pins, definition availability, and
  read-only status.
- Top-level port: name, direction, width, and connected network.
- Multiple nodes: selection count and common read-only state.

The status strip remains a compact selection summary. It does not replace the
Inspector.

For `.ad`, the same panel progressively adds editable parameter overrides,
port definitions, scalar connections, interface connections, effective
defaults and their origins, and export settings. Edits are sent as typed
commands to the document host; the webview never writes files directly.

## Selection Data Flow

```text
X6 node click/rubber band -> selected node IDs
X6 edge/junction click    -> selected network ID
graph refresh             -> revalidate semantic selection
selection state           -> renderer highlights + Inspector model
.v/.sv Inspector          -> local read-only projection
.ad Inspector edit        -> typed host command -> validated document edit
```

Only one network may be selected at a time. Selecting a network clears node
selection; selecting nodes clears network selection. Search can select hidden
network names and reveal their highlighted geometry.

## Arch Design Delivery

The `.ad` work proceeds in the approved dependency order:

1. Complete the shared visual fixes and Inspector selection model.
2. Add the versioned `.ad` schema, parser, serializer, migrations, validator,
   top-level port semantics, defaults, and deterministic RTL exporter.
3. Add `veriflow ad validate` and `veriflow ad export` to the Node CLI.
4. Register the `.ad` custom editor and add instance, port, connection,
   parameter, validation, and export operations.
5. Add protocol recognition, collapsed interfaces, effective defaults, and
   project-defined protocols.

Invalid `.ad` intermediate states remain visible with localized diagnostics.
Export remains atomic and blocked by semantic errors. Existing `.v/.sv`
documents never become editable through this work.

## Error Handling

Inspector rendering tolerates missing definitions and unknown widths and shows
those states explicitly. Stale selected IDs are cleared on graph refresh.
Malformed webview edit commands are rejected at the protocol boundary.

Unknown `.ad` schema versions open read-only. Failed validation does not mutate
the document. Failed export does not replace the previous generated RTL.

## Verification

All implementation follows test-driven development and uses Node/TypeScript
tests only.

- Core tests assert no network-label geometry or bounds inflation, deterministic
  port labels, and stable render models.
- Webview tests assert semantic network selection, absence of edge selection
  boxes, complete Inspector properties, and theme-token use.
- Electron tests click individual segments and verify the whole network alone
  highlights, node rubber-band selection still works, and port labels remain
  visible at desktop and constrained widths.
- Screenshot and canvas-pixel checks cover light, dark, and high-contrast
  themes at desktop and narrow viewports.
- Arch Design golden tests cover validation, scalar and inout ports, defaults,
  deterministic Verilog/SystemVerilog output, and overwrite refusal.
- CLI and VSIX packaging tests remain release gates.

No Python code or Python test path is restored.

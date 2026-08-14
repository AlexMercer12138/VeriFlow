# Arch Design VS Code Editor Design

## Summary

This phase turns schema-v1 `.ad` files into editable VS Code documents while
keeping `.v` and `.sv` schematics read-only. The editor reuses the existing X6
schematic webview and all graph, placement, routing, validation, and RTL export
logic from `@veriflow/schematic-core`.

The implementation has three ownership layers:

- `@veriflow/schematic-core/arch-design` owns deterministic document edits.
- `ArchDesignEditorProvider` owns VS Code document, catalog, diagnostics,
  undo/redo, save, and export integration.
- `@veriflow/schematic-webview` owns authoring controls and pin interaction but
  never reads or writes files directly.

Protocol recognition and collapsed AXI/APB/AHB interfaces remain the next
phase. This phase edits scalar ports and connections only.

## Chosen Architecture

The editor uses a separate `veriflow.archDesignEditor` custom text editor. It
shares the schematic HTML, CSS, graph renderer, selection model, and Inspector
with `veriflow.schematicEditor`, but has its own document host.

This is preferred over adding mode branches throughout the existing HDL
provider because HDL refresh, source navigation, include watching, and layout
storage already have a large read-only regression surface. A separate webview
would isolate the host but duplicate rendering and interaction behavior. The
chosen split isolates document semantics while retaining one visual surface.

The webview protocol gains optional authoring state and two commands:

```text
host -> archDesignState(revision, editable, design, catalog, validation)
web  -> editArchDesign(revision, edit)
web  -> exportArchDesign(revision)
```

Existing initialize, graph, diagnostics, search, layout, and navigation
messages stay compatible. HDL providers never emit authoring state and reject
authoring commands at their exhaustive command boundary.

## Shared Edit Model

The shared core exposes a discriminated `ArchDesignEdit` union and
`applyArchDesignEdit(design, edit)`. Supported edits are:

- add, rename, and remove an instance;
- set or clear an instance parameter override;
- add, update, and remove a top-level port;
- connect two scalar endpoints, rename/remove a connection, or disconnect one
  endpoint;
- set or clear a design- or connection-level default;
- set export language/output;
- replace persisted presentation after layout changes.

The reducer returns a fresh parsed and frozen `ArchDesign`. It rejects stale or
unknown targets and invalid edit payloads without mutating the input. Renames
update scalar endpoints, default keys, and stable presentation node IDs.
Deletes remove references to the deleted declaration and drop empty
connections. Connecting two existing networks merges them in declaration
order; otherwise it extends or creates a deterministically named network.

The reducer enforces schema shape and identifier validity but does not require
the result to be semantically exportable. Missing drivers and width errors are
valid editor intermediate states and remain visible through validation.

## Document Lifecycle

The provider parses the current `TextDocument`, scans HDL module definitions
through the existing workspace index, projects the design graph and placement,
and publishes one immutable editor snapshot. Each snapshot has a revision token
bound to the source document version and catalog generation.

An edit command is accepted only when its revision matches the latest editable
snapshot. The provider applies the reducer, serializes the result with
`serializeArchDesign`, and replaces the complete text through a VS Code
`WorkspaceEdit`. This gives every logical edit native dirty-state, save,
undo, redo, and external-change behavior. Document change events rebuild and
republish the graph; the webview never assumes an edit succeeded.

Layout saves are converted from `SchematicLayout` to `design.presentation` and
use the same document-edit path. Only stable port and instance placement is
persisted. Viewport remains webview-local, and constant/default nodes remain derived.

Unknown schema versions open read-only. Invalid JSON or schema text publishes
localized diagnostics and retains the most recent valid graph when one exists.
Index invalidation refreshes catalog bindings and validation without rewriting
the document.

## Authoring UI

Authoring mode adds compact icon buttons for instance, port, connection, and
RTL export operations. Buttons are hidden for HDL schematics and disabled for
unsupported or invalid AD documents.

The Inspector becomes form-based only in AD mode:

- no selection: module and export settings;
- instance: name, module, parameter overrides, and remove action;
- top-level port: name, direction, width, defaults, and remove action;
- network: name, endpoints, receiver defaults, and remove action.

Module and direction choices use selects; binary choices use checkboxes;
commands use Lucide icon buttons with tooltips. A small modal handles adding an
instance or port. Text stays sized for the 280-pixel Inspector and constrained
viewports.

Scalar connections use pin-to-pin drag. AD pin magnets create only a temporary
preview edge. On completion the preview is removed and one typed endpoint-pair
edit is sent to the host. The next host graph is the source of truth. Invalid
connections are allowed structurally and shown by semantic diagnostics.

## Validation And Export

Parser and semantic diagnostics are published to the webview and a dedicated
VS Code diagnostic collection. Semantic diagnostics use their JSON path in the
message and point to the document when an exact JSON token range is not
available.

Export uses `exportArchDesignRtl` with the current catalog. The default target
is the sibling `.v`; `design.export.output` and SystemVerilog `.sv` selection
are respected. Existing hand-written targets are never overwritten. Generated
targets are replaced atomically and failures leave the prior file unchanged.
Successful export reveals the output path through a VS Code notification.

## Verification

All behavior is developed test-first:

- shared reducer tests cover every edit, cascading rename/delete, network
  merge, immutable inputs, and invalid payloads;
- protocol tests reject malformed, oversized, stale-shaped, and
  prototype-hostile messages;
- provider tests cover parse/catalog races, unsupported schemas, native
  WorkspaceEdit undo units, layout persistence, diagnostics, and disposal;
- webview and Electron tests cover authoring controls, Inspector fields,
  pin-drag commands, selected-network continuity, and narrow layouts;
- manifest, generated assets, VSIX packaging, release smoke, and the full Node
  product matrix remain gates.

No Python code or Python test path is introduced.

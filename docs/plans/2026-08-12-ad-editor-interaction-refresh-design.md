# AD Editor Interaction Refresh Design

## Problem

The Arch Design editor currently routes selection, viewport, and node movement
through the same interaction path. Every resulting text document change
causes the provider to publish `initialize`, `graph`, and `archDesignState`
again. The webview clears and rebuilds the X6 graph, so ordinary interaction
briefly shows the loading state and immediately loses the user's selection.

The first valid graph also applies the default runtime viewport. This leaves a
new design in the upper-left corner even though the editor already has a
fit-to-content operation.

## Ownership

Selection is transient editor state. In Arch Design documents it is retained
only in the webview state and is never written into `design.presentation`.
Read-only HDL schematics keep their existing layout-store behavior.

Viewport remains webview-local state and never schedules an Arch Design document
write. Node placement remains persistent presentation state: the webview applies
it immediately and sends one debounced `saveLayout` message. A successful
provider-owned presentation edit must not rebuild the graph.

Semantic edits, external text changes, undo/redo, catalog invalidation, and
parse failures continue to publish a complete snapshot and graph.

## Presentation Write Protocol

The provider tracks the exact serialized text and design associated with its
in-flight presentation replacement. When the matching text document change is
observed, it consumes that pending write, advances the provider snapshot to
the new document version, and publishes a lightweight `archDesignLayoutSaved`
event containing the new revision and editable state.

The webview handles this event without clearing cells. It updates the current
revision and Arch Design state revision while keeping selection, Inspector
contents, graph cells, viewport, and search state. Layout and semantic writes
share one serialized queue, so a layout acknowledgement never releases a
semantic operation that is still pending.

If another layout arrives while a presentation edit is in flight, both the
webview and provider retain only the latest layout. The provider applies it
after the current document change advances the revision. Page teardown forwards
the latest queued layout to the provider before the webview is destroyed.

If the observed document text does not exactly match the pending replacement,
the provider treats it as an external or semantic change and performs the
normal full refresh. A failed workspace edit clears the pending write and uses
the existing recovery refresh.

The provider snapshot must adopt the presentation-updated design before the
next semantic edit. Otherwise a subsequent reducer operation could serialize
an older presentation and undo the user's latest movement.

## Initial Viewport

On the first render of an Arch Design graph, the webview calls
`zoomToFit({ padding: 24, maxScale: 1 })` after cells are created. It updates
only the in-memory layout; automatic fit, panning, and zooming do not send
`saveLayout` and do not dirty the document. Later graph refreshes in the same
webview retain the current local view instead of fitting again.

## Expected Interaction

- Selecting a node or network updates highlighting and the Inspector only.
- Panning and zooming never clear or rebuild the graph.
- Moving nodes reruns local placement and routing while preserving selection,
  then persists the resulting presentation once after the debounce.
- A presentation acknowledgement updates revisions without replacing cells.
- A semantic edit still shows the host-produced graph as the source of truth,
  then persists any newer local layout using the refreshed revision.
- Relayout All recomputes placement and routing locally and uses the same
  lightweight layout-save path.
- A newly opened design is centered once.

## Verification

Provider tests distinguish matching provider-owned presentation changes from
external changes and prove that the updated presentation survives the next
semantic edit. Electron tests prove that AD selection sends no layout save,
layout acknowledgement preserves cell identity and selection, movement saves
once, and first render fits without persisting the view.

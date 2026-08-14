# AD Short Routing And Boundary Port Shapes

## Goal

Improve AD schematic readability without replacing the existing placement and
routing architecture. Clear cross-column connections should use the shortest
safe orthogonal path, while congested and feedback cases must retain the
current deterministic corridor fallback. Boundary port shapes should make the
left-to-right design flow visible and make every inout pin's purpose
discoverable without adding permanent canvas labels.

## Routing Design

Keep the current column placement, routing grid, transactional allocation,
occupancy indexes, tree construction, and junction calculation. Add a short
`H-V-H` path plan to the ordinary routing candidate set. For a connection whose
endpoints are in different columns, consider vertical tracks in the channels
between the endpoints. Materialize each candidate from the source pin to the
track, vertically to the target pin row, and then to the target pin.

Every short candidate passes through the existing module-intersection and
collinear-reservation validation. Candidate ordering continues to prefer the
smallest realized added wire length, then fewer bends and allocation actions,
then trunk reuse and stable coordinates. A clear aligned path therefore becomes
a direct line, a clear unaligned path becomes `H-V-H`, and blocked paths fall
back to the existing internal or outer `H-V-H-V-H` corridor. Feedback routing
continues to use outer corridors because its topology communicates reverse data
flow and avoids cutting across the forward-flow columns.

## Boundary Port Design

Classify rendered boundary nodes from their graph metadata. Scalar input and
output ports and aggregate master and slave interfaces use a right-pointing
pentagonal body. Their existing accent color remains unchanged: scalar ports
stay green and aggregate interfaces stay purple.

Inout ports use the same right-pointing pentagonal body as input and output
ports. Their `_o`, `_t`, and `_i` pins receive separate rows: `_o` and `_t` on
the left, `_i` on the right. The `_t` pin uses an amber double-ring marker so
it remains distinguishable without relying on color alone. All three markers
provide native hover descriptions: `Output drive (O)`, `Tri-state enable (T)`,
and `Input sense (I)`. These semantics apply only to the generated three-pin
top-level inout node, not to ordinary instance pins with similar names.

The node grows vertically when needed, while single-pin scalar and collapsed
interface ports retain the current compact height. Expanded interface members
also receive distinct rows so their anchors never overlap.

The render model continues to use rectangular bounds for placement, selection,
collision checks, and clipping. Only the SVG body path changes, keeping routing
geometry and persisted layouts compatible.

## Verification

Add focused tests for a clear three-column `H-V-H` route, obstacle fallback,
deterministic routing, and non-overlap invariants. Include the multi-network
adjacent-column case where several pins terminate on the same module: ordering
must use realized pin Y coordinates rather than the module row. Add node
geometry tests for the inout side split and webview-facing tests for its body,
marker, and hover descriptions. Finally, capture the actual AD demo and assert
that the reported segment sequences for `sample_in`, `sample_valid`,
`s_axi_control`, `result_out`, and `result_valid` are `H-V-H` where unaligned.
Run schematic-core tests, webview and VS Code tests, then the complete Node test
suite. Python tests remain out of scope.

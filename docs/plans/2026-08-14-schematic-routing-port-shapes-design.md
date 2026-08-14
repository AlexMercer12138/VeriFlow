# AD Short Routing And Boundary Port Shapes

## Goal

Improve AD schematic readability without replacing the existing placement and
routing architecture. Clear cross-column connections should use the shortest
safe orthogonal path, while congested and feedback cases must retain the
current deterministic corridor fallback. Boundary port shapes should make the
left-to-right design flow visible and give inout ports a distinct bidirectional
appearance.

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

Inout ports use a symmetric double-ended hexagonal body. Unlike single-pin
ports, their `_o`, `_t`, and `_i` pins receive separate rows: `_o` and `_t` on
the left, `_i` on the right. The node grows vertically when needed, while
single-pin scalar and collapsed interface ports retain the current compact
height. Expanded interface members also receive distinct rows so their anchors
never overlap.

The render model continues to use rectangular bounds for placement, selection,
collision checks, and clipping. Only the SVG body path changes, keeping routing
geometry and persisted layouts compatible.

## Verification

Add focused tests for a clear three-column `H-V-H` route, obstacle fallback,
deterministic routing, and non-overlap invariants. Add node geometry tests for
multi-pin boundary rows and webview-facing shape classification/path tests for
scalar, interface, and inout ports. Run schematic-core tests, webview and VS
Code tests, then the complete Node test suite. Python tests remain out of scope.

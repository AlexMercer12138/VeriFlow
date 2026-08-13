# AD Click-to-Connect Design

## Goal

Replace press-and-drag Arch Design connection authoring with a two-click interaction that remains usable while the canvas is panned between endpoints.

## Interaction

Connection mode remains an explicit toolbar mode. Clicking a connectable pin circle stores that pin as the pending endpoint, highlights it, and draws a dashed preview from the pin to the pointer. Right-button canvas panning does not clear the pending endpoint. Clicking a second compatible pin completes the edit; clicking the pending pin again, pressing Escape, disabling connection mode, or receiving a refreshed graph cancels it.

An incompatible second pin does not create an edit and leaves the first pin pending so the user can choose another endpoint. Pin-label clicks continue to select pins for inspection and do not start a connection.

## Direction And Semantics

Click order is independent of design direction. After both endpoints are known, scalar endpoints are normalized to driver-to-load and interface endpoints to Master-to-Slave before the existing `connect` or `connectInterface` command is sent. Bidirectional scalar endpoints retain stable click order only when both sides are otherwise equivalent. Network rendering and RTL export therefore keep their existing semantic direction and arrow behavior.

The AD schema, edit protocol, validation, routing, and RTL exporter are unchanged.

## Lifecycle

The pending state owns only stable cell and port IDs plus a temporary X6 edge. It is cleared before semantic graph replacement so it cannot refer to stale cells. Authoring becoming read-only or pending also cancels it. Normal pin inspection remains independent from connection state.

## Verification

Electron interaction tests cover scalar and interface connections in reverse click order, pending state across right-button panning, incompatible targets, same-pin/Escape cancellation, and graph refresh cleanup. Existing VS Code and shared-core suites verify that the unchanged host protocol and semantic direction remain compatible.

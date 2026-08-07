# Unified Web Frontend and HDL Runtime Architecture Design

## Summary

Unify VeriFlow's browser-based frontends on TypeScript, esbuild, a shared host
transport, and one browser-preview workflow. The existing waveform viewer,
schematic editor, and VS Code Testbench Generator Webview remain separate
applications with purpose-built rendering, but they use the same build and
hosting conventions.

Move all Verilog and SystemVerilog source parsing behind the existing
TypeScript `tree-sitter-systemverilog` implementation. VS Code continues to
run the shared parser core in `worker_threads`. The Python CLI and GUI use the
same core through a long-lived, self-contained Windows parser worker delivered
in a version-locked Python wheel. Python users do not install Node.js or npm.

This is an architecture program rather than one large implementation change.
Delivery is divided into independently verified plans for workspace/build
foundations, shared HDL runtime and worker packaging, Webview migration, and
Python parser cutover.

## Goals

- Make TypeScript the source language for every browser-based VeriFlow UI.
- Build every browser-based UI with one shared esbuild configuration.
- Preserve Canvas 2D for waveform rendering and AntV X6/SVG for schematics.
- Move the VS Code Testbench Generator out of provider-embedded HTML and
  JavaScript into a normal TypeScript Webview application.
- Give every Webview a normal-browser preview with deterministic fixtures and
  screenshot automation.
- Remove Python's direct rewriting of generated JavaScript.
- Make the TypeScript SystemVerilog preprocessor, Tree-sitter adapter, HDL
  model, workspace index, and dependency analysis the only source parser
  implementation.
- Let VS Code and Python consume that implementation through host-specific,
  narrow adapters.
- Keep Python installation and runtime free of Node.js and npm requirements.
- Deliver the Windows x64 parser worker as a version-locked Python wheel.
- Keep the current Python domain-service interfaces stable while replacing
  their parser implementation.
- Remove the legacy Python regex parser after a controlled comparison period.
- Keep every migration phase testable and releasable.

## Non-Goals

- Do not migrate native Qt widgets to Qt WebEngine.
- Do not replace the waveform Canvas renderer with X6 or SVG.
- Do not replace X6 in the schematic editor as part of this migration.
- Do not improve schematic node layout or edge routing in this work.
- Do not redesign the waveform, schematic, or Testbench Generator UI.
- Do not require the VS Code extension to launch the external parser process.
- Do not ship Linux or macOS parser-worker binaries in the first release.
- Do not retain the regex parser as a permanent or silent fallback.
- Do not download parser executables on first application launch.
- Do not expose a local TCP service for parser communication.

## Confirmed Decisions

- Architecture: one shared TypeScript HDL core with multiple host adapters.
- VS Code parser execution: the existing lazy Node `worker_threads` model.
- Python parser execution: a long-lived self-contained sidecar process.
- Sidecar protocol: versioned UTF-8 JSON Lines over stdin and stdout.
- Sidecar packaging: esbuild plus Node Single Executable Applications (SEA),
  with the two pinned WASM files delivered beside the executable.
- Python distribution: a Windows x64 `veriflow-hdl-worker` wheel whose version
  is locked to the main VeriFlow release.
- First platform: Windows x64 only. Later platform work requires a separate
  design and release pipeline.
- Web frontend language: TypeScript.
- Web frontend bundler: esbuild with a shared base configuration.
- Generated Web assets: deterministic, unminified, committed artifacts under
  top-level `web-dist/`.
- Native Qt interface: unchanged.
- Legacy parser exit: retain only behind a test-only comparison switch during
  migration, then delete before completion.

## Current Constraints

The Python waveform host currently reads the same waveform HTML, CSS, and
JavaScript files as the VS Code extension. It embeds those files into a Qt
WebEngine document and communicates through `QWebChannel`. The current Python
HTML builder removes the ready message and injects bootstrap state by exact
JavaScript string replacement. Bundling or minification can change those
strings, so the migration must replace text rewriting with an explicit runtime
bootstrap contract before converting the waveform viewer.

The Python Verilog services currently use regular expressions and handwritten
preprocessing for module declarations, ports, parameters, includes, instances,
and dependency ordering. Those services are used by CLI analysis, GUI module
scanning, Testbench generation, and simulation file ordering. Replacing only
the port parser would leave divergent source semantics in place.

The VS Code extension already owns the stronger implementation: pinned
`web-tree-sitter` and `tree-sitter-systemverilog` WASM assets, preprocessing,
Tree-sitter adaptation, normalized HDL models, incremental parsing, workspace
indexing, dependency analysis, and parser diagnostics.

## Repository Architecture

Add a root npm workspace with explicit packages:

```text
packages/
  hdl-core/              preprocessing, Tree-sitter adaptation, HDL models
  hdl-runtime/           parser initialization, cache, incremental parsing
  hdl-protocol/          requests, responses, versions, schemas, errors
  webview-runtime/       host transport, bootstrap, state, theme primitives
  waveform-webview/      waveform TypeScript application
  schematic-webview/     schematic TypeScript application
  testbench-webview/     VS Code Testbench Generator application
  parser-worker/         JSONL sidecar entry point and SEA build

python-packages/
  veriflow-hdl-worker/   wheel metadata and packaged Windows runtime

web-dist/
  waveform/              committed browser artifacts
  schematic/
  testbench/

veriflow-vscode/
  src/                   VS Code host adapters and extension code
  media/                 generated packaging copies of web-dist assets
```

The top-level `web-dist/` directory is the canonical generated Web artifact.
Python source runs load it directly. The VS Code build copies it into the
extension package. PyInstaller collects it into the Python application.
Generated copies under extension packaging directories must not become a
second source of truth.

## Dependency Boundaries

```text
                      hdl-protocol
                       /          \
                      v            v
             VS Code adapter    Python client
                    |                |
             worker_threads     JSONL sidecar
                    \                /
                     v              v
                  hdl-runtime -> hdl-core

 waveform-webview  schematic-webview  testbench-webview
          \              |              /
                    webview-runtime
                 /          |          \
          VS Code host    Qt host    Browser preview
```

Rules:

- `hdl-core` must not import `vscode`, Qt, Python, process transport, or a UI.
- `hdl-runtime` may depend on `web-tree-sitter` but not on a host transport.
- Raw Tree-sitter nodes never cross the runtime boundary.
- `hdl-protocol` owns serializable schemas and the protocol version.
- VS Code and Python adapters may map shared results into host models but may
  not reimplement source parsing.
- `webview-runtime` must not contain waveform, schematic, or Testbench
  business logic.
- Webview applications must not directly access `acquireVsCodeApi`,
  `QWebChannel`, or Python globals.

## Shared HDL Services

The shared runtime exposes high-level source services rather than only a raw
parse-tree endpoint:

- parse a Verilog or SystemVerilog document;
- index one or more workspace roots;
- apply include-directory and define configuration;
- analyze dependencies and deterministic compile order;
- look up a path-qualified module definition;
- return module, parameter, port, instance, include, network, and diagnostic
  models;
- cancel queued work;
- dispose runtime caches.

This keeps Python from duplicating workspace indexing and dependency logic.
The normalized `HdlDocument` remains the semantic source of truth. Python
adapters initially map it into the existing `ModuleInfo`, `Port`, `Parameter`,
and `DependencyResult` contracts so CLI and native Qt consumers need minimal
changes.

## Host Execution

### VS Code

VS Code continues to own one lazy parser worker thread. The worker initializes
the shared runtime on first use, owns active trees and caches, prioritizes open
document work, and returns serializable shared models. This preserves current
extension responsiveness and does not make the VSIX platform-specific.

### Python

The Python process starts one worker lazily on the first HDL operation. CLI and
GUI use the same Python client. The GUI invokes synchronous service facades
from its existing background-task infrastructure and never waits for parser
I/O on the Qt UI thread.

The worker remains alive for the application session, reusing its initialized
WASM runtime, workspace index, and parse cache. Application shutdown sends a
graceful dispose request and applies a bounded termination fallback.

## Parser Worker Protocol

The wire format is UTF-8 JSON Lines. Each stdout line is one complete protocol
message. stdout is reserved for protocol output; diagnostic logs go to stderr.
`hdl-protocol` defines the same logical request and response schemas for both
hosts: VS Code carries them over a worker-thread `MessagePort`, while Python
frames them as JSON Lines over the sidecar pipes.

Every request contains:

```json
{
  "protocolVersion": 1,
  "requestId": "42",
  "type": "parseDocument",
  "payload": {}
}
```

Every response repeats `protocolVersion`, `requestId`, and `type`, and includes
an `ok` discriminator. Successful responses contain `payload`; failed
responses contain a structured `error` and no success payload.

The first request is `initialize`. It supplies workspace roots, include and
library directories, defines, encoding policy, and resource limits. The
response reports:

- protocol version;
- core version;
- Tree-sitter grammar version;
- runtime and grammar WASM SHA-256 values;
- supported request capabilities.

Required operations are:

- `initialize`;
- `parseDocument`;
- `indexWorkspace`;
- `analyzeDependencies`;
- `getModule`;
- `cancel`;
- `dispose`.

The protocol supports multiple outstanding request IDs. The runtime schedules
Tree-sitter parsing serially per parser instance while allowing callers to
queue and cancel independent operations.

## Worker Safety and Resource Limits

- Use anonymous stdin/stdout pipes only; do not listen on a local port.
- Start only the executable path returned by the installed runtime wheel.
- Launch the Windows process without a visible console window.
- Validate every request and response with a bounded schema.
- Limit line length, document size, workspace file count, and total scan bytes.
- Normalize workspace and include paths and restrict scanning to initialized
  roots and explicitly configured include or library directories.
- Bound captured stderr to a diagnostic tail rather than retaining all logs.
- Discard late responses after cancellation.
- Do not execute shell commands or interpret HDL as JavaScript.

## Error Model

Errors have three classes:

1. HDL diagnostics are successful parse results containing structured errors,
   warnings, and source spans.
2. Request errors such as invalid input, missing files, or exceeded limits fail
   only the matching request.
3. Runtime errors such as protocol mismatch, invalid WASM checksums, startup
   failure, or worker crashes fail the runtime.

Unexpected worker exit rejects every pending request immediately. The Python
client may restart the worker once and retry only idempotent read operations
that produced no response. A second crash in the same short window disables
automatic restart and surfaces a user-readable error containing the runtime
version, exit code, and bounded stderr tail.

There is no production regex fallback. During migration, a test-only switch may
run both implementations and compare results, but errors in the new worker
must never silently select the legacy implementation.

## Worker Build and Python Wheel

The selected packaging chain is:

```text
TypeScript parser-worker
        -> esbuild CJS entry
        -> Node SEA Windows executable
        -> veriflow-hdl-worker wheel
```

The wheel contains:

```text
veriflow_hdl_worker/
  parser-worker.exe
  web-tree-sitter.wasm
  tree-sitter-systemverilog.wasm
  manifest.json
  runtime.py
```

`runtime.py` returns installed resource paths and manifest metadata; it does
not contain parser behavior. `manifest.json` records versions, protocol
capabilities, sizes, and checksums.

The main Python package depends on an exact matching worker-wheel version. A
normal Python installation or editable installation acquires the wheel through
Python packaging. Parser developers and release CI need Node/npm; normal
Python contributors and users do not.

Node SEA compatibility with the pinned `web-tree-sitter` and external WASM
assets is a phase-zero gate. If the feasibility build fails, work stops and
this design is revised. The implementation must not silently replace SEA with
another runtime or commit a large executable to Git.

## Unified Webview Runtime

`webview-runtime` provides:

- a typed `HostTransport` interface;
- VS Code message and persisted-state adaptation;
- Qt WebChannel adaptation;
- memory/browser-preview adaptation;
- bootstrap configuration parsing;
- message subscription and disposal;
- shared theme tokens and minimal base CSS primitives.

The common startup sequence is:

```text
host writes bootstrap configuration
        -> index.html loads index.css and index.js
        -> webview-runtime selects the host adapter
        -> application sends ready
        -> host sends typed initialization data
```

The bootstrap contract replaces Python's exact JavaScript string replacement.
Qt-specific QWebChannel initialization remains inside the Qt transport adapter.

## Webview Applications

### Waveform

Move the current JavaScript to TypeScript without changing visible behavior.
Split the large entry point into state, transport, data, viewport, rendering,
interaction, search, layout, and bootstrap modules. Retain Canvas 2D and the
existing indexed waveform protocol.

### Schematic

Move the existing TypeScript source into the workspace package and switch it
to the common runtime and build configuration. Retain X6, Dagre, current graph
models, and current layout/routing behavior.

### Testbench Generator

Move provider-embedded HTML, CSS, and JavaScript into a dedicated TypeScript
Webview package. The VS Code provider remains responsible for extension-host
operations and sends typed messages to the Webview.

### Native Qt UI

Project configuration, file trees, logs, module controls, and Python's native
Testbench UI remain Qt widgets. Only the existing waveform browser surface
uses the shared Web assets in Python.

## Web Build and Artifacts

All Web applications use one esbuild base configuration:

- TypeScript input;
- browser platform;
- IIFE output;
- ES2020 target;
- deterministic unminified bundles;
- shared static HTML and CSS copy rules;
- explicit third-party-license collection;
- no inline provider source generation.

The root build commands are:

```text
npm run build:web
npm run build:parser
npm run build:vscode
npm run verify:generated
```

`build:web` recreates `web-dist/`. `build:vscode` copies the canonical Web
assets into the extension packaging tree. `verify:generated` performs a clean
rebuild and fails if tracked `web-dist/` changes.

Committed Web artifacts let Python run from a source checkout without npm.
The parser executable is different: it is too large and platform-specific for
Git and is supplied through the Python worker wheel.

## Browser Preview and Visual Verification

Each Web application has deterministic preview fixtures:

```text
fixtures/waveform/
fixtures/schematic/
fixtures/testbench/
```

The unified preview command accepts an application name:

```text
npm run preview -- waveform
npm run preview -- schematic
npm run preview -- testbench
```

Preview hosts use the same typed transport contract as VS Code and Qt. They
must support automated interaction, console-log capture, screenshots, and
nonblank Canvas/SVG checks without modifying production assets.

## Release Pipeline

The release order is fixed:

```text
install and build shared npm workspace
  -> run shared TypeScript tests
  -> build and smoke-test parser-worker.exe
  -> build veriflow-hdl-worker wheel
  -> install the wheel into the Python test environment
  -> run Python tests and integration tests
  -> build and test PyInstaller artifacts
  -> build and test the VSIX
```

The release process must test the actual installed wheel rather than a loose
development executable. The final Python runtime test runs with Node and npm
removed from `PATH`.

## Migration Phases

### Phase 0: Feasibility Gate

Build the smallest SEA worker and verify pinned `web-tree-sitter`, both WASM
assets, JSONL I/O, hidden Windows process startup, wheel resource lookup, and
PyInstaller collection.

### Phase 1: Workspace and Build Foundation

Add the root npm workspace, package boundaries, shared TypeScript/esbuild
configuration, canonical `web-dist/`, generated-artifact verification, and
license collection without changing product behavior.

### Phase 2: Shared HDL Core Extraction

Move existing preprocessing, Tree-sitter adaptation, models, runtime, and
workspace indexing out of VS Code-specific directories. Keep the VS Code
worker client and every current extension regression passing.

### Phase 3: Web Frontend Migration

Migrate in this order:

```text
schematic -> Testbench Generator -> waveform
```

The schematic validates the runtime using an already-TypeScript application.
The Testbench Generator removes embedded provider code. The largest and most
sensitive application, waveform, moves last and is split incrementally.

### Phase 4: Sidecar and Worker Wheel

Implement protocol schemas, lifecycle, cancellation, restart behavior, SEA
packaging, wheel metadata, and installed-wheel integration tests.

### Phase 5: Python Shadow Integration

Add `HdlWorkerClient` and shared-model adapters. In tests, run old and new
implementations against the same fixture matrix and compare modules, ports,
parameters, instances, includes, defines, dependency graphs, compile order,
duplicates, missing modules, and diagnostics.

Every difference is classified as a legacy defect correction, an intentional
model change, or a new-runtime defect. Unexplained differences block cutover.

### Phase 6: Python Cutover

Switch port parsing, Testbench generation, dependency analysis, CLI workflows,
and GUI workflows one consumer at a time. After real-project verification,
delete the regex parser and test-only comparison switch.

### Phase 7: Release Hardening

Update PyInstaller, VSIX, release scripts, dependency locks, licenses, and
clean-environment installation tests. Verify no worker process remains after
CLI or GUI shutdown.

## Testing Strategy

### Shared TypeScript Core

- Golden parsing tests for ANSI and non-ANSI declarations, parameters, ports,
  instances, includes, conditional compilation, generate constructs, and
  multi-module files.
- Workspace index, duplicates, missing modules, and deterministic topological
  ordering tests.
- Incremental parsing and configuration-fingerprint invalidation tests.
- Protocol schema, malformed input, size-limit, cancellation, and late-response
  tests.
- Preserve current VS Code HDL, dependency, instantiation, Testbench, and
  schematic regressions.

### Parser Worker and Wheel

- Development-entry integration tests.
- Real SEA executable integration tests.
- Installed-wheel path and checksum tests.
- Handshake, concurrency, cancellation, timeout, crash, one-time restart, and
  protocol-version mismatch tests.
- stdout protocol-purity and bounded-stderr tests.
- Windows hidden-process and graceful-shutdown tests.

### Python Integration

- Shared-model to Python-domain-model mapping tests.
- CLI dependency, compile order, missing module, and duplicate module tests.
- GUI scan and Testbench generation tests using the worker.
- New-versus-legacy structured comparison during migration.
- Missing, corrupt, or mismatched worker errors.
- Process cleanup tests after normal exit and failure.

### Web Frontends

- TypeScript unit tests for all three Web applications.
- Browser fixture interaction tests.
- Desktop screenshot baselines.
- Canvas nonblank-pixel tests for waveform rendering.
- SVG/X6 node and edge count tests for schematics.
- VS Code Webview integration tests.
- Qt WebEngine waveform smoke and screenshot tests.
- Zero unhandled browser-console errors.

### Release Verification

In a clean Windows environment without Node/npm:

```text
install Python packages
  -> run CLI HDL indexing and dependency analysis
  -> start GUI
  -> open a VCD waveform
  -> generate a Testbench
  -> close the application
  -> verify no parser process remains
```

Install the VSIX separately and verify module scanning, schematic display,
waveform display, and the Testbench Generator.

## Performance Gates

Record baseline timings and memory before migration. After migration:

- warm workspace indexing and single-document parsing may not regress by more
  than 25 percent on the agreed fixture set;
- waveform pan, zoom, and indexed window requests may not show a measurable
  regression outside benchmark variance;
- worker cold start is recorded separately from warm incremental parsing;
- repeated requests may not cause unbounded memory, process-handle, or file-
  handle growth.

No absolute performance target is invented without a recorded baseline.

## Completion Criteria

- Every browser-based VeriFlow UI has TypeScript source and the shared esbuild
  build path.
- Waveform, schematic, and Testbench Generator use `webview-runtime` rather
  than direct host APIs.
- Python no longer rewrites generated JavaScript.
- Python source runs use committed `web-dist/` assets without npm.
- VS Code and Python use the same HDL core, runtime models, and protocol.
- Python installation and runtime do not require Node.js or npm.
- The Windows x64 worker wheel installs, verifies, parses, and packages through
  PyInstaller.
- The production regex parser and migration switch are deleted.
- `web-dist/` rebuilds deterministically with no drift.
- Python, VS Code, browser, Qt, worker-wheel, PyInstaller, and VSIX tests pass.
- No parser worker remains after application shutdown.
- Schematic layout and routing behavior remain outside this migration.

## Implementation Plan Decomposition

This design is intentionally broader than one safe implementation plan. After
design approval, produce separate plans in this order:

1. workspace, artifact, and SEA feasibility foundation;
2. shared HDL package extraction and protocol;
3. parser sidecar, Python wheel, and Python client;
4. Webview runtime and three frontend migrations;
5. Python shadow comparison, cutover, legacy removal, and release hardening.

Each plan must leave the repository passing and may not assume later plans are
already complete.

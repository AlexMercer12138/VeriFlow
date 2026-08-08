# Node CLI and VS Code Shared Core Design

## Summary

VeriFlow will converge on two product forms: a Node CLI and the VS Code
extension. Both products consume host-neutral TypeScript packages for HDL
parsing and indexing, project configuration, dependency analysis, simulation,
and waveform indexing. The Python GUI and CLI remain available only during a
measured compatibility window and are deleted after the Node CLI meets every
behavior and release gate.

The Node CLI preserves the current `veriflow` command name, command hierarchy,
options, project JSON schema, global configuration path, stdout/stderr text,
and exit codes. Existing automation and project files must not require a
conversion step.

## Product Boundaries

```text
packages/
  hdl-core/             normalized HDL models and source semantics
  hdl-runtime/          parser worker, workspace index, dependency services
  flow-core/            project/config, log, template, simulation contracts
  waveform-runtime/     VCD index/cache and waveform worker client
  waveform-webview/     shared browser waveform application
  cli/                  compatible command parsing and orchestration
  waveform-desktop/     Electron main process, preload, and IPC adapter

veriflow-vscode/
  src/                  VS Code lifecycle and presentation adapters only
```

Shared packages must not import `vscode`, Electron, Qt, Python, or product
entry points. Product packages may depend on shared packages, but shared
packages may not depend on product packages. Temporary re-export files under
`veriflow-vscode/src/core` preserve imports while code is moved; each shim is
deleted once all extension consumers use package public APIs.

## Shared Flow Core

`@veriflow/flow-core` owns the project schema and compatibility behavior. Its
public API loads and saves the existing snake_case JSON structure, resolves
project and library paths relative to the project file, supplies the current
simulator and waveform-viewer defaults, and reads `~/.veriflow_config.json`.
No schema rename is part of this migration.

Simulation uses a narrow asynchronous contract:

```typescript
export interface SimulatorBackend {
  compileAndRun(request: SimulationRequest, signal?: AbortSignal):
    Promise<SimulationResult>;
}
```

The first backend wraps the existing native command templates and child
process behavior. A future Icarus WASM backend can implement the same contract
without changing CLI commands, VS Code workflows, project files, log parsing,
or result presentation. The migration does not bundle Icarus WASM yet.

Paths are represented as file URLs at HDL/index boundaries and native paths at
process/config boundaries. A shared path-style helper selects POSIX or Windows
semantics from the value rather than the host OS. This is required for remote
workspaces and for deterministic cross-platform tests.

## HDL Runtime

The existing TypeScript preprocessor, Tree-sitter adapter, normalized model,
parser queue/client, workspace index, and dependency analyzer move out of the
VS Code source tree without behavior changes. VS Code continues to use a Node
`worker_threads` parser. The Node CLI uses the same runtime and worker bundle;
there is no JSONL sidecar, Python client, or worker wheel in the final design.

The runtime receives host-neutral file discovery, reading, include resolution,
and persistence interfaces. VS Code implements them with its workspace APIs.
The CLI implements them with Node filesystem APIs. Raw Tree-sitter nodes do
not cross the runtime API.

## Node CLI Compatibility

The Node CLI implements all current leaf commands:

```text
project new|open|show
lib add|remove|list
top set|get
analyze
sim
wave
```

Python characterization tests record success and failure output, exit codes,
filesystem changes, and JSON serialization. The Node suite consumes the same
case definitions. Intentional fixes require an explicit fixture update and a
decision-log entry; otherwise output drift is a migration failure.

The first distributable is an npm package exposing the `veriflow` binary.
Standalone executable packaging is a release layer and must not change core or
CLI APIs.

## Electron Waveform Host

`veriflow wave -p project.json` resolves the VCD path exactly as the Python CLI
does, then launches the Electron waveform product. Electron loads the tracked
`web-dist/waveform` assets and exposes `__waveformMemoryTransport` from a
context-isolated preload script. Renderer messages are validated and routed to
the shared `WaveformWorkerClient`; worker messages are routed back to the
renderer.

The host supports `ready`, indexed window/value/search requests, cancellation,
retry, file-stability reload, and graceful worker disposal. Layout persistence
uses the webview's existing local storage outside VS Code. Closing the last
window terminates workers and returns control to the CLI. `nodeIntegration`
remains disabled.

## Migration and Removal Gates

The migration follows a strangler sequence:

1. Freeze and characterize Python product behavior.
2. Extract shared packages while VS Code imports through compatibility shims.
3. Add compatible Node configuration commands.
4. Add shared HDL analyze and native simulation commands.
5. Add the Electron waveform host.
6. Publish the Node CLI as the default and mark Python products deprecated.
7. Remove Python product code only after the compatibility, clean-install,
   packaging, real-project, and process-cleanup gates all pass.

Rollback is always possible before step 7 because the Python entry points and
release artifacts remain intact. After removal, Python may remain only for
clearly scoped development utilities that have not yet been replaced; no
Python runtime is shipped as a product dependency.

## Error and Lifecycle Rules

- User/configuration errors return exit code 1 and preserve current messages.
- Unexpected errors never print a Python-style traceback from the Node CLI.
- Parser and waveform workers are disposed on success, failure, cancellation,
  SIGINT, and Electron window close.
- Native simulator output is streamed or captured without changing command
  template expansion or path quoting.
- Runtime/package version mismatches fail visibly; there is no fallback to the
  Python implementation in production.

## Verification

Every extraction step runs package tests plus the complete VS Code suite.
Every CLI step runs shared compatibility cases against Python and Node until
the Python product is retired. Release verification covers Windows, Linux,
and macOS npm installs; Electron packaging and visual tests cover supported
desktop platforms. Canvas pixel checks, console-error capture, worker cleanup,
and VCD indexing benchmarks remain release gates.

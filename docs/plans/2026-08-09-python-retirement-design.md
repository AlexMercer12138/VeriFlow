# Python Retirement Design

## Goal

Remove every maintained Python source, test, package, build artifact, and
workflow from Vik-VeriFlow. The repository will support only the Node CLI and
the VS Code extension, backed by shared TypeScript packages.

## Scope

Delete the Python GUI and CLI, the Python domain and infrastructure layers,
all Python tests, Python packaging metadata, PyInstaller specifications, the
worker-wheel bridge, and Python-only development scripts. JSON, Verilog, WASM,
and other language-neutral fixtures remain when Node tests consume them.
Historical plans, decisions, performance results, and v1.4.0 release evidence
remain as records, but active documentation must describe the Node-only state.

Replace `scripts/run_release.py` with a Node release command that preserves
version consistency checks, changelog checks, package version updates, CLI
contract version updates, release verification, npm tarball creation, and VSIX
packaging. Remove Python and PyInstaller jobs from CI and tag releases. The
Windows parser feasibility job may retain its Node SEA checks, but no wheel or
Python collection path remains.

## Compatibility

The existing Node CLI contract is the behavioral boundary. Run its complete
contract suite before deletion and run the same suite after each retirement
phase. Project JSON, global configuration, command output, exit codes,
simulation behavior, and waveform launching must not change. No Python tests
will be executed during this work.

Add a Node source-policy test that initially fails while Python files and
workflow references exist. It must reject Python source and packaging files,
Python commands in active package scripts and workflows, Python product entry
points, and deprecated Python release assets.

## Documentation

Rewrite the root README in concise Chinese. It will cover project purpose,
features, prerequisites, Node CLI installation and command examples, VS Code
extension usage, project configuration, source-development commands, release
downloads, and license. It will not document internal module structure,
migration history, Python setup, or detailed implementation mechanics.

## Verification

The final gate consists only of Node and product checks: shared TypeScript
typecheck/tests, the full Node CLI contract, Electron lifecycle tests, VS Code
tests and packaging, generated-asset verification, clean npm install smoke,
Node release-script tests, source-policy tests, and `git diff --check`.

Success means the active repository contains no Python code or packaging, CI
and releases require no Python runtime, the Node CLI behavior is unchanged,
and the README accurately presents the two maintained products.

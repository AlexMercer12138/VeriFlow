# Node CLI and VS Code Shared Core Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Python GUI/CLI products with a Python-CLI-compatible Node CLI and an Electron waveform window while making the Node CLI and VS Code extension share host-neutral TypeScript core packages.

**Architecture:** Use a strangler migration. Characterize Python behavior first, extract TypeScript packages behind temporary VS Code re-exports, add the Node CLI one workflow at a time, and delete Python products only after parity and release gates pass. Keep simulator execution behind a backend interface so Icarus WASM can be added later without changing product APIs.

**Tech Stack:** TypeScript 5.9, Node.js 24, npm workspaces, `worker_threads`, Tree-sitter/WASM, Electron, esbuild, Node test runner, pytest compatibility fixtures.

---

### Task 1: Restore a portable green migration baseline

**Files:**
- Create: `veriflow-vscode/src/core/pathStyle.ts`
- Create: `veriflow-vscode/src/test/pathStyle.test.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/scripts/run-tests.mjs`
- Modify: `scripts/lib/files.mjs`

**Step 1: Write a failing path-style test**

Cover relative paths for two POSIX paths, two Windows drive paths while tests
run on Linux, different Windows drives, and mixed/invalid path styles. Require
forward slashes for user-facing descriptions.

**Step 2: Run the focused test and confirm the current native `path.relative` behavior fails**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/pathStyle.test.js`

Expected: FAIL because `pathStyle.ts` does not exist.

**Step 3: Implement the minimal host-neutral path helper**

```typescript
export function relativeDisplayPath(root: string, target: string): string {
  const api = /^[A-Za-z]:[\\/]/.test(root) && /^[A-Za-z]:[\\/]/.test(target)
    ? path.win32
    : path.posix;
  const relative = api.relative(root, target);
  return relative && !api.isAbsolute(relative)
    ? relative.split(api.sep).join('/')
    : target;
}
```

Treat a `..` result as valid for display only where the caller explicitly
allows it. Update top-module choices to use the helper.

**Step 4: Run the focused and full Node suites**

Run: `npm test`

Expected: parser and VS Code suites pass on Linux, including the existing
Windows-URI fixture.

**Step 5: Prevent generated binary mode churn**

Update the deterministic copy helper to preserve the executable mode declared
by tracked destinations rather than applying source package modes to WASM
assets. Rebuild twice and require a clean `git diff --check` and no mode-only
change under `veriflow-vscode/media/parsers`.

**Step 6: Commit**

```bash
git add veriflow-vscode/src/core/pathStyle.ts veriflow-vscode/src/test/pathStyle.test.ts veriflow-vscode/src/extension.ts veriflow-vscode/scripts/run-tests.mjs scripts/lib/files.mjs
git commit -m "fix: make shared path display host neutral"
```

### Task 2: Characterize the complete Python CLI contract

**Files:**
- Create: `tests/cli_contract/cases.json`
- Create: `tests/cli_contract/fixtures/`
- Create: `tests/test_cli_contract.py`
- Create: `scripts/capture_cli_contract.py`
- Modify: `tests/conftest.py`

**Step 1: Add cases for every command and major failure**

Record argv, working directory, initial files, expected stdout, expected
stderr, exit code, and expected JSON/global-config changes for all eleven leaf
commands. Include missing project, missing top, missing module, missing wave
file, unknown simulator, relative paths, and global library add/remove.

**Step 2: Run the characterization harness and inspect discoveries**

Run: `PYTHONPATH=/tmp/veriflow-pydeps python3 -m pytest tests/test_cli_contract.py -v`

Expected: FAIL until captured results match actual Python behavior. Do not
correct surprising legacy behavior in this task; classify it in the fixture.

**Step 3: Add deterministic capture and assertions**

Invoke `src.presentation.cli.main` in-process with isolated home/project
directories. Normalize only test-root prefixes and platform separators; do
not normalize meaningful whitespace, labels, or error text.

**Step 4: Run existing CLI/project tests plus the contract suite**

Run: `PYTHONPATH=/tmp/veriflow-pydeps python3 -m pytest tests/test_cli_and_simulation.py tests/test_project_config.py tests/test_cli_contract.py -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/cli_contract tests/test_cli_contract.py tests/conftest.py scripts/capture_cli_contract.py
git commit -m "test: freeze Python CLI compatibility contract"
```

### Task 3: Create host-neutral workspace package boundaries

**Files:**
- Create: `packages/flow-core/package.json`
- Create: `packages/flow-core/tsconfig.json`
- Create: `packages/flow-core/tsconfig.test.json`
- Create: `packages/flow-core/src/index.ts`
- Create: `packages/flow-core/test/boundaries.test.ts`
- Create: `packages/hdl-core/package.json`
- Create: `packages/hdl-runtime/package.json`
- Create: `packages/waveform-runtime/package.json`
- Modify: `package.json`
- Modify: `tsconfig.base.json`

**Step 1: Write failing package-boundary tests**

Require public package imports to compile from a temporary consumer and reject
imports of `vscode`, Electron, Python paths, or product entry points from
shared package sources.

**Step 2: Run and verify failure**

Run: `npm test --workspace @veriflow/flow-core`

Expected: FAIL because packages do not exist.

**Step 3: Add minimal package manifests and TypeScript references**

Keep runtime dependencies explicit and avoid depending on
`veriflow-vscode`. Add root scripts for shared typecheck and tests.

**Step 4: Run workspace tests**

Run: `npm test`

Expected: existing products and empty boundary packages pass.

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json packages/flow-core packages/hdl-core packages/hdl-runtime packages/waveform-runtime
git commit -m "build: define shared TypeScript package boundaries"
```

### Task 4: Move flow primitives and preserve VS Code imports

**Files:**
- Create: `packages/flow-core/src/types.ts`
- Create: `packages/flow-core/src/logParser.ts`
- Create: `packages/flow-core/src/templateEngine.ts`
- Create: `packages/flow-core/src/pathStyle.ts`
- Create: `packages/flow-core/test/flowPrimitives.test.ts`
- Modify: `veriflow-vscode/src/core/types.ts`
- Modify: `veriflow-vscode/src/core/logParser.ts`
- Modify: `veriflow-vscode/src/core/templateEngine.ts`
- Modify: `veriflow-vscode/src/core/pathStyle.ts`

**Step 1: Move existing tests to package-level public imports**

Copy the current log, template, shared type, and path assertions into one
package test. Update expected imports before moving production code.

**Step 2: Verify package tests fail**

Run: `npm test --workspace @veriflow/flow-core`

Expected: FAIL because public exports are absent.

**Step 3: Move production implementations and add temporary re-exports**

The VS Code files contain exports only, for example:

```typescript
export * from '@veriflow/flow-core/logParser';
```

No implementation is duplicated.

**Step 4: Run package and complete extension tests**

Run: `npm test --workspace @veriflow/flow-core && npm test --workspace veriflow-vscode`

Expected: PASS with unchanged extension behavior.

**Step 5: Commit**

```bash
git add packages/flow-core veriflow-vscode/src/core
git commit -m "refactor: share flow primitives with product hosts"
```

### Task 5: Implement compatible project and global configuration services

**Files:**
- Create: `packages/flow-core/src/project.ts`
- Create: `packages/flow-core/src/projectStore.ts`
- Create: `packages/flow-core/src/globalConfigStore.ts`
- Create: `packages/flow-core/src/defaults.ts`
- Create: `packages/flow-core/test/projectStore.test.ts`
- Test: `tests/cli_contract/cases.json`

**Step 1: Write failing round-trip tests from Python fixtures**

Load legacy and current project JSON, resolve relative paths, add missing
defaults in memory, save with relative paths, and require snake_case output
byte structure apart from the final newline policy captured by fixtures.

**Step 2: Verify failure**

Run: `npm test --workspace @veriflow/flow-core -- projectStore`

Expected: FAIL because stores are missing.

**Step 3: Implement minimal schema-compatible services**

Validate required object shapes without dropping unknown project keys. Use an
injected home directory for global config tests and `os.homedir()` in product
code.

**Step 4: Run package and Python round-trip suites**

Run: `npm test --workspace @veriflow/flow-core`

Run: `PYTHONPATH=/tmp/veriflow-pydeps python3 -m pytest tests/test_project_config.py tests/test_cli_contract.py -v`

Expected: both pass against the same fixtures.

**Step 5: Commit**

```bash
git add packages/flow-core tests/cli_contract
git commit -m "feat: share compatible VeriFlow project configuration"
```

### Task 6: Add the Node CLI shell and compatible configuration commands

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/main.ts`
- Create: `packages/cli/src/commands/project.ts`
- Create: `packages/cli/src/commands/lib.ts`
- Create: `packages/cli/src/commands/top.ts`
- Create: `packages/cli/test/cliContract.test.ts`
- Modify: `package.json`

**Step 1: Make contract tests invoke a missing Node CLI**

Run the project, lib, top, help, and version cases. Compare stdout, stderr,
exit code, and filesystem effects exactly.

**Step 2: Verify expected failure**

Run: `npm test --workspace @veriflow/cli`

Expected: FAIL because the `veriflow` Node entry point is absent.

**Step 3: Implement the minimal CLI parser and commands**

Use a focused CLI dependency only if Node `parseArgs` cannot reproduce nested
help and argparse formatting. Preserve the public binary name and use injected
stdio/cwd/home in tests.

**Step 4: Run Node and Python contract suites**

Run: `npm test --workspace @veriflow/cli`

Run: `PYTHONPATH=/tmp/veriflow-pydeps python3 -m pytest tests/test_cli_contract.py -v`

Expected: configuration-command cases match.

**Step 5: Commit**

```bash
git add packages/cli package.json package-lock.json
git commit -m "feat: add compatible Node CLI configuration commands"
```

### Task 7: Extract HDL core and runtime from VS Code

**Files:**
- Move: `veriflow-vscode/src/core/hdl/model.ts` -> `packages/hdl-core/src/model.ts`
- Move: `veriflow-vscode/src/core/hdl/preprocessor.ts` -> `packages/hdl-core/src/preprocessor.ts`
- Move: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts` -> `packages/hdl-core/src/treeSitterAdapter.ts`
- Move: remaining source-semantics helpers -> `packages/hdl-core/src/`
- Move: parser client/worker/queue -> `packages/hdl-runtime/src/`
- Move: workspace index/store/types -> `packages/hdl-runtime/src/`
- Move: `veriflow-vscode/src/core/dependencyAnalyzer.ts` -> `packages/hdl-runtime/src/dependencyAnalyzer.ts`
- Modify: `veriflow-vscode/src/core/hdl/*.ts`
- Modify: `veriflow-vscode/scripts/build.mjs`
- Move/adapt: `veriflow-vscode/src/test/hdl*.test.ts` -> package tests

**Step 1: Convert parser/model/index tests to package public imports**

Move tests by subsystem, one at a time. Each moved test must fail before its
implementation moves.

**Step 2: Move source-semantics modules into `hdl-core`**

Run: `npm test --workspace @veriflow/hdl-core`

Expected: golden parser/preprocessor/model tests pass.

**Step 3: Move worker lifecycle and workspace indexing into `hdl-runtime`**

Inject file discovery, reading, include resolution, and persistence. Preserve
request priority, cancellation, cache, and generation behavior.

**Step 4: Add VS Code re-exports/adapters and update worker build entry**

Run: `npm test --workspace @veriflow/hdl-runtime && npm test --workspace veriflow-vscode`

Expected: package and complete extension suites pass.

**Step 5: Commit each green subsystem**

Use separate commits for model/preprocessor, parser runtime, workspace index,
and dependency analysis. Do not combine the entire extraction in one commit.

### Task 8: Implement compatible `analyze` and `sim`

**Files:**
- Create: `packages/cli/src/runtime/nodeWorkspaceHost.ts`
- Create: `packages/cli/src/commands/analyze.ts`
- Create: `packages/flow-core/src/simulation.ts`
- Create: `packages/flow-core/src/nativeSimulatorBackend.ts`
- Create: `packages/cli/src/commands/sim.ts`
- Create: `packages/cli/test/analyzeContract.test.ts`
- Create: `packages/cli/test/simContract.test.ts`
- Modify: `packages/cli/src/main.ts`

**Step 1: Run analyze contract cases against missing implementation**

Expected: FAIL with the command unregistered.

**Step 2: Implement the Node filesystem workspace host and analyze command**

Use the shared HDL runtime and exact project/global library ordering. Dispose
the parser worker in `finally` and on SIGINT.

**Step 3: Run analyze parity cases**

Run: `npm test --workspace @veriflow/cli -- analyzeContract`

Expected: compile order, missing modules, output, and exit codes match Python.

**Step 4: Add a failing native simulation backend test**

Use a fake executable fixture to capture argv/cwd/stdout/stderr without
mocking the backend internals. Require the current template expansion and
elapsed/result semantics.

**Step 5: Implement `NativeSimulatorBackend` and `sim`**

Keep the `SimulatorBackend` interface independent from native commands so a
future `IcarusWasmBackend` can be added separately.

**Step 6: Run CLI, flow-core, and VS Code tests**

Run: `npm test --workspace @veriflow/flow-core && npm test --workspace @veriflow/cli && npm test --workspace veriflow-vscode`

Expected: PASS.

### Task 9: Extract waveform runtime and add Electron host

**Files:**
- Move: `veriflow-vscode/src/core/vcdIndex*.ts` -> `packages/waveform-runtime/src/`
- Move: `veriflow-vscode/src/core/waveformCache.ts` -> `packages/waveform-runtime/src/`
- Move: `veriflow-vscode/src/core/waveformWorker*.ts` -> `packages/waveform-runtime/src/`
- Create: `packages/waveform-desktop/package.json`
- Create: `packages/waveform-desktop/src/main.ts`
- Create: `packages/waveform-desktop/src/preload.ts`
- Create: `packages/waveform-desktop/src/router.ts`
- Create: `packages/waveform-desktop/test/router.test.ts`
- Create: `packages/cli/src/commands/wave.ts`
- Modify: `packages/cli/src/main.ts`

**Step 1: Move waveform runtime tests to public package imports**

Run: `npm test --workspace @veriflow/waveform-runtime`

Expected: FAIL before implementations move, then pass after each subsystem.

**Step 2: Write a failing Electron router test**

Use an in-memory IPC pair and a real `WaveformWorkerClient` fixture. Cover
ready/open, window/value/search forwarding, cancellation, retry, malformed
messages, and disposal.

**Step 3: Implement context-isolated Electron transport**

Expose only `__waveformMemoryTransport.send` and `.onMessage`. Keep
`nodeIntegration: false`, enable `contextIsolation`, and validate every
renderer message.

**Step 4: Implement compatible `wave` command**

Resolve the project wave path and errors before launching Electron. External
viewer configurations continue to use the native process backend.

**Step 5: Run visual and lifecycle tests**

Use Playwright/Electron to verify a nonblank Canvas, interactions, no console
errors, reload, and zero remaining worker processes after window close.

**Step 6: Commit in runtime and host increments**

```bash
git commit -m "refactor: share waveform indexing runtime"
git commit -m "feat: open indexed waveforms from the Node CLI"
```

### Task 10: Publish the Node CLI and deprecate Python products

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `scripts/run_release.py` or replace with `scripts/run-release.mjs`
- Modify: `README.md`
- Modify: `pyproject.toml`
- Modify: `VeriFlow.spec`
- Modify: `VeriFlow-cli.spec`
- Modify: `veriflow-vscode/CHANGELOG.md`

**Step 1: Add failing clean-install and artifact tests**

Test npm pack/install in an empty directory, CLI help/version/analyze, VSIX
packaging, Electron asset presence, and absence of source-tree path reliance.

**Step 2: Add Node CLI and Electron artifacts to the release pipeline**

Keep Python artifacts during the deprecation release. Mark Python entry points
deprecated in docs and startup output without changing command behavior.

**Step 3: Run cross-product release verification**

Run shared package tests, CLI compatibility tests, VS Code tests, generated
asset checks, npm pack smoke, Electron smoke, and Python contract tests.

**Step 4: Publish one deprecation release and record evidence**

Do not remove Python in the same release that first makes Node the default.

### Task 11: Remove Python GUI/CLI after the retirement gate

**Files:**
- Delete: `src/presentation/gui/`
- Delete: `src/presentation/cli.py`
- Delete: Python domain/infrastructure files no longer used by tooling
- Delete: `run_gui.py`
- Delete: `run_cli.py`
- Delete: `VeriFlow.spec`
- Delete: `VeriFlow-cli.spec`
- Delete: Python product tests superseded by shared/CLI tests
- Modify: `pyproject.toml`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: Verify the retirement checklist**

Require complete command parity, project/global config round trips, real HDL
projects, native simulator runs, Electron waveform behavior, clean installs,
worker cleanup, and a completed deprecation release.

**Step 2: Delete Python product entry points and packaging**

Keep only explicitly justified Python development utilities. No shipped
product may require Python or PySide6.

**Step 3: Run the final source-policy and release gates**

Require no Python GUI/CLI entry points, no VS Code imports in shared packages,
no implementation under VS Code compatibility shims, and successful npm,
VSIX, and Electron artifacts.

**Step 4: Record the completed retirement decision and commit**

```bash
git commit -m "refactor: retire Python VeriFlow products"
```

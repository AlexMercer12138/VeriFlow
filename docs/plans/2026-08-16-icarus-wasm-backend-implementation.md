# Icarus WASM Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Icarus WASM the stable `builtin` Verilog-2005 simulator in the CLI and VS Code extension while preserving native simulators, establishing regression/performance infrastructure, and starting the TypeScript simulator on a measured foundation.

**Architecture:** Keep the common simulation contract and backend registry in `@veriflow/flow-core`, and put the MIT-licensed adapter to the GPL runtime in a separate `@veriflow/simulator-iverilog-wasm` package. The CommonJS adapter loads the ESM-only `@veriflow/iverilog-wasm` package through a preserved native dynamic-import boundary; the VSIX copies the upstream package verbatim to a vendor directory so `import.meta.url`, worker, and WASM asset resolution remain intact. Product hosts select one backend explicitly and pass the same cancellation, timeout, source, resource, and artifact request.

**Tech Stack:** TypeScript 5.9, CommonJS product packages, ESM Icarus WASM package, Node.js `worker_threads`, Node child processes, Node test runner, esbuild, VS Code extension APIs, npm packing, GitHub Actions.

---

## Preconditions

- Execute VeriFlow tasks in an isolated worktree created from commit `ac220c5` or later.
- Execute upstream Icarus tasks in a separate worktree of `/home/mercer/prj/iverilog`.
- Do not mix upstream and VeriFlow changes in one commit.
- Publish an immutable Icarus WASM version before committing VeriFlow's registry lockfile.
- Use IEEE 1364-2005 for every built-in product request, regardless of source extension.
- Do not add SystemVerilog or external VPI/PLI handling to the TypeScript backend.
- Do not bundle Icarus generated ESM, worker, or WASM files with esbuild. Copy them verbatim and test their final URLs.

## Task 1: Qualify And Release The Icarus WASM Runtime

Work in `/home/mercer/prj/iverilog`.

**Files:**
- Modify: `/home/mercer/prj/iverilog/wasm/package/package.json`
- Modify: `/home/mercer/prj/iverilog/wasm/package/README.md`
- Modify: `/home/mercer/prj/iverilog/wasm/README.md`
- Modify: `/home/mercer/prj/iverilog/wasm/package/test/package.test.mjs`
- Modify: `/home/mercer/prj/iverilog/wasm/test/clean-install.mjs`
- Modify: `/home/mercer/prj/iverilog/wasm/test/size-budget.mjs`
- Modify: `/home/mercer/prj/iverilog/wasm/test/source-metadata.test.mjs`
- Modify: `/home/mercer/prj/iverilog/.github/workflows/test.yml`
- Test: `/home/mercer/prj/iverilog/wasm/package/test/package.test.mjs`
- Test: `/home/mercer/prj/iverilog/wasm/package/test/simulate.test.mjs`
- Test: `/home/mercer/prj/iverilog/wasm/package/test/lifecycle.test.mjs`

**Step 1: Add a failing runtime-version package test**

Add an assertion that the declared engine matches the oldest extension-host runtime actually supported:

```js
test('package supports the declared extension-host Node baseline', async () => {
    const metadata = JSON.parse(await readFile(
        path.join(packageRoot, 'package.json'),
        'utf8',
    ));
    assert.equal(metadata.engines.node, '>=18.15.0');
});
```

Replace test-only `import.meta.dirname` uses with `fileURLToPath(import.meta.url)` so the test suite itself can run on Node 18.

**Step 2: Run the test and verify it fails**

Run:

```bash
cd /home/mercer/prj/iverilog
npm --prefix wasm/package run build:ts
node --test wasm/package/test/package.test.mjs
```

Expected: FAIL because `engines.node` is `>=24.14.1`.

**Step 3: Add the runtime matrix before lowering the declaration**

Split the WASM workflow into a build/package job and a clean-install runtime matrix. Upload the `.tgz` once, then execute real `simulate()` smoke tests under Node 18.15+, 20, 22, and 24. Do not rebuild the WASM payload for each Node version.

The smoke program must compile and run Verilog-2005, return `PASS`, produce a VCD artifact, abort an infinite simulation, and leave no active worker handles.

**Step 4: Run local oldest-runtime smoke**

Run:

```bash
cd /home/mercer/prj/iverilog
make -C wasm package
npx --yes node@18.15.0 wasm/test/clean-install.mjs
```

Expected before compatibility fixes: FAIL on any Node API or test syntax that is newer than Node 18. Expected after fixes: PASS and print the clean-install success summary.

**Step 5: Lower the engine only after the smoke passes**

Set:

```json
{
  "version": "0.1.1",
  "engines": {
    "node": ">=18.15.0"
  }
}
```

Update both READMEs to say the package remains ESM-only and supports Node 18.15 or newer. Do not add a CommonJS main entry; Task 6 owns that boundary in the adapter.

**Step 6: Run the complete upstream verification**

Run:

```bash
cd /home/mercer/prj/iverilog
make -C wasm clean build package
npm --prefix wasm/package test
node --test wasm/test/*.test.mjs
```

Expected: PASS. `wasm/package/veriflow-iverilog-wasm-0.1.1.tgz` exists, contains `dist/SOURCE.md`, and contains no absolute build paths.

**Step 7: Commit and publish the prerequisite**

```bash
git add .github/workflows/test.yml wasm
git commit -m "feat(wasm): support extension host runtimes"
npm publish ./wasm/package/veriflow-iverilog-wasm-0.1.1.tgz --access public
npm view @veriflow/iverilog-wasm@0.1.1 version dist.integrity engines --json
```

Expected: registry output reports version `0.1.1`, an integrity value, and `node: >=18.15.0`. Record the upstream commit and integrity in the implementation log before continuing.

## Task 2: Generalize The Simulation Contract

Work in `/home/mercer/prj/VeriFlow`.

**Files:**
- Modify: `packages/flow-core/src/simulation.ts`
- Modify: `packages/flow-core/src/types.ts`
- Modify: `packages/flow-core/src/index.ts`
- Modify: `packages/flow-core/src/nativeSimulatorBackend.ts`
- Modify: `packages/flow-core/package.json`
- Test: `packages/flow-core/test/simulation.test.ts`

**Step 1: Write failing contract-shape tests**

Add compile-time fixtures and runtime assertions for request defaults, artifact reporting, stage timings, and abort propagation. The intended public shape is:

```ts
export type SimulationStage = 'input' | 'compile' | 'run' | 'infrastructure';

export interface SimulationArtifactRequest {
    kind: 'vcd' | 'file';
    path: string;
    destination: string;
    required?: boolean;
}

export interface SimulationRequest {
    files: string[];
    runtimeFiles: string[];
    includeDirs: string[];
    defines: Record<string, string | number | boolean>;
    plusargs: string[];
    artifacts: SimulationArtifactRequest[];
    output: string;
    cwd: string;
    topModule?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface SimulationArtifactResult extends SimulationArtifactRequest {
    written: boolean;
    size: number;
}

export interface SimulationExecution extends SimulationResult {
    backendId: string;
    stage: SimulationStage;
    timings: Partial<Record<'preprocess' | 'compile' | 'run' | 'artifact', number>>;
    commands: { compile?: string; run?: string };
    artifacts: SimulationArtifactResult[];
}
```

Remove `simulator: SimulatorConfig` from `SimulationRequest`; a backend instance owns its configuration. Migrate `NativeSimulatorBackend` far enough in this task that the workspace compiles and its existing success/failure tests remain green. Task 4 adds full cancellation, timing, template, and artifact behavior.

**Step 2: Run the focused tests**

Run:

```bash
npm test --workspace @veriflow/flow-core
```

Expected: TypeScript compilation FAILS because the new request/result fields and helper are absent.

**Step 3: Add a request builder with conservative defaults**

Implement `createSimulationRequest()` in `packages/flow-core/src/simulation.ts`. It must clone arrays and records, default to a 300,000 ms timeout, and reject non-positive or unsafe timeout values. Do not read files in the contract layer.

**Step 4: Re-run the focused tests**

Run `npm test --workspace @veriflow/flow-core`.

Expected: all flow-core tests PASS. Do not commit a contract change that leaves the native backend uncompilable.

**Step 5: Commit**

```bash
git add packages/flow-core
git commit -m "refactor(sim): generalize backend request contract"
```

## Task 3: Add The Explicit Backend Registry

**Files:**
- Create: `packages/flow-core/src/simulatorBackendRegistry.ts`
- Modify: `packages/flow-core/src/index.ts`
- Modify: `packages/flow-core/package.json`
- Test: `packages/flow-core/test/simulatorBackendRegistry.test.ts`

**Step 1: Write failing registry tests**

Cover registration, lazy async creation, duplicate IDs, unknown IDs, provider failure, and no fallback. The central assertion is:

```ts
await assert.rejects(
    registry.run('experimental-ts', request),
    /experimental-ts unavailable/,
);
assert.equal(builtinCalls, 0);
```

**Step 2: Run the test and verify it fails**

Run:

```bash
npm test --workspace @veriflow/flow-core
```

Expected: FAIL because `SimulatorBackendRegistry` does not exist.

**Step 3: Implement the minimal registry**

```ts
export type SimulatorBackendProvider = () => SimulatorBackend | Promise<SimulatorBackend>;

export class SimulatorBackendRegistry {
    private readonly providers = new Map<string, SimulatorBackendProvider>();

    register(id: string, provider: SimulatorBackendProvider): void {
        if (!id || this.providers.has(id)) {
            throw new Error(`Simulation backend already registered: ${id}`);
        }
        this.providers.set(id, provider);
    }

    async resolve(id: string): Promise<SimulatorBackend> {
        const provider = this.providers.get(id);
        if (!provider) throw new Error(`Unknown simulation backend: ${id}`);
        return provider();
    }

    async run(id: string, request: SimulationRequest): Promise<SimulationExecution> {
        return (await this.resolve(id)).compileAndRun(request);
    }
}
```

Do not catch a provider or backend error and invoke a second provider.

**Step 4: Run tests and commit**

Run `npm test --workspace @veriflow/flow-core`; expect PASS.

```bash
git add packages/flow-core
git commit -m "feat(sim): add explicit backend registry"
```

## Task 4: Migrate And Cancel Native Simulation

**Files:**
- Modify: `packages/flow-core/src/nativeSimulatorBackend.ts`
- Modify: `packages/flow-core/src/simulation.ts`
- Modify: `packages/flow-core/src/templateEngine.ts`
- Test: `packages/flow-core/test/simulation.test.ts`
- Test: `packages/flow-core/test/flowPrimitives.test.ts`
- Modify: `packages/flow-core/test/fixtures/fakeSimulator.mjs`

**Step 1: Add failing cancellation and result tests**

Add tests proving that:

- the constructor migration from Task 2 remains compatible with registry creation;
- `CommandExecutor.execute()` receives the request's `AbortSignal`;
- abort terminates a long-running child process and resolves as an infrastructure-stage failure;
- compile and run timings are separate;
- requested VCD existence is reported without copying it; and
- `{defines}` and `{include_dirs}` render only when command templates request them.

**Step 2: Run and observe failure**

Run `npm test --workspace @veriflow/flow-core`.

Expected: FAIL on executor signal handling, stage timings, and artifact reporting.

**Step 3: Implement cancellable execution**

Change the interface to:

```ts
execute(
    command: string,
    cwd: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
): Promise<ProcessExecution>;
```

Pass `signal` to `child_process.exec`. Normalize abort and timeout separately from HDL exit codes. Ensure listeners are removed after the callback settles.

**Step 4: Migrate the native backend**

Use a constructor shaped like:

```ts
constructor(
    private readonly backendId: string,
    private readonly simulator: SimulatorConfig,
    private readonly executor: CommandExecutor = new NodeCommandExecutor(),
) {}
```

Return `commands`, `stage`, `timings`, and `artifacts`. Preserve legacy shell-template behavior for `iverilog`, `vcs`, `xsim`, and `custom`.

**Step 5: Run tests and commit**

Run:

```bash
npm test --workspace @veriflow/flow-core
```

Expected: PASS, including the real abort test.

```bash
git add packages/flow-core
git commit -m "feat(sim): make native backend asynchronous and cancellable"
```

## Task 5: Preserve Project Compatibility While Adding Built-In Inputs

**Files:**
- Modify: `packages/flow-core/src/project.ts`
- Modify: `packages/flow-core/src/projectStore.ts`
- Modify: `packages/flow-core/src/defaults.ts`
- Test: `packages/flow-core/test/projectStore.test.ts`
- Modify: `packages/cli/src/commands/project.ts`
- Test: `packages/cli/test/cliContract.test.ts`

**Step 1: Write failing compatibility tests**

Test these exact rules:

- `ProjectStore.create()` selects `builtin` for new projects.
- Opening a legacy file with no `simulator` field still selects `iverilog`.
- Explicit `iverilog` remains an external command-template backend.
- `native-iverilog` is available with Verilog-2005 defaults.
- `defines` accepts string, number, and boolean values.
- `simulation_files` resolves relative paths and round-trips.
- Unknown project keys still round-trip when `preserveUnknown` is enabled.

**Step 2: Run and verify failures**

Run:

```bash
npm test --workspace @veriflow/flow-core
npm test --workspace @veriflow/cli
```

Expected: FAIL because the new default and fields are absent.

**Step 3: Extend the project model**

Add:

```ts
defines: Record<string, string | number | boolean>;
simulationFiles: string[];
```

Persist them as `defines` and `simulation_files`. Add both keys to `PROJECT_KEYS`.

Keep these defaults distinct:

```ts
// New project
simulator: 'builtin'

// Legacy project with missing field
stringField(data, 'simulator', 'iverilog')
```

Add `native-iverilog` to `DEFAULT_SIMULATORS`, but keep the existing `iverilog` entry unchanged as the legacy alias.

**Step 4: Run tests and commit**

Run the two workspace tests; expect PASS.

```bash
git add packages/flow-core packages/cli
git commit -m "feat(sim): add builtin project configuration"
```

## Task 6: Create The CommonJS-Safe Icarus WASM Adapter

**Files:**
- Create: `packages/simulator-iverilog-wasm/package.json`
- Create: `packages/simulator-iverilog-wasm/tsconfig.json`
- Create: `packages/simulator-iverilog-wasm/tsconfig.test.json`
- Create: `packages/simulator-iverilog-wasm/src/index.ts`
- Create: `packages/simulator-iverilog-wasm/src/loadIverilog.ts`
- Create: `packages/simulator-iverilog-wasm/src/iverilogApi.ts`
- Create: `packages/simulator-iverilog-wasm/test/moduleBoundary.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Add the exact upstream dependency**

Create `@veriflow/simulator-iverilog-wasm` as a CommonJS package licensed MIT for the adapter source, with exact dependencies:

```json
{
  "name": "@veriflow/simulator-iverilog-wasm",
  "version": "1.4.2",
  "type": "commonjs",
  "license": "MIT",
  "dependencies": {
    "@veriflow/flow-core": "1.4.2",
    "@veriflow/iverilog-wasm": "0.1.1"
  }
}
```

Do not use a range for the GPL binary package.

**Step 2: Write failing CommonJS and bundle-boundary tests**

The test must:

1. `require()` the compiled adapter from CommonJS.
2. Load the upstream ESM module through the adapter.
3. Run a real Verilog-2005 simulation.
4. Bundle the adapter to CommonJS with esbuild while externalizing `@veriflow/iverilog-wasm`.
5. Run the bundled output and verify the worker can still find `worker.js` and all WASM files.
6. Assert the generated bundle does not contain embedded WASM data or an inlined worker.

Run:

```bash
npm test --workspace @veriflow/simulator-iverilog-wasm
```

Expected: FAIL because the package and loader do not exist.

**Step 3: Preserve native dynamic import**

Implement the only dynamic boundary in `src/loadIverilog.ts`:

```ts
import type { IverilogApi } from './iverilogApi';

const importEsm = new Function(
    'specifier',
    'return import(specifier);',
) as (specifier: string) => Promise<IverilogApi>;

export function loadIverilog(
    specifier = '@veriflow/iverilog-wasm',
): Promise<IverilogApi> {
    return importEsm(specifier);
}
```

The specifier is supplied only by trusted product wiring. Validate that it is either the exact bare package name or a `file:` URL under the extension directory. Do not accept workspace or HDL input as a module specifier.

This `Function` boundary is intentional: TypeScript's CommonJS transform would otherwise rewrite `import()` to `require()`, which cannot load the ESM-only package. Keep a dedicated test so future bundler changes cannot remove it.

**Step 4: Run tests and commit**

Run:

```bash
npm install
npm test --workspace @veriflow/simulator-iverilog-wasm
```

Expected: PASS with a real `PASS` simulation and no `ERR_REQUIRE_ESM`.

```bash
git add package.json package-lock.json packages/simulator-iverilog-wasm
git commit -m "feat(sim): add Icarus WASM adapter package"
```

## Task 7: Build A Deterministic Virtual Workspace

**Files:**
- Create: `packages/simulator-iverilog-wasm/src/virtualWorkspace.ts`
- Create: `packages/simulator-iverilog-wasm/src/artifactWriter.ts`
- Test: `packages/simulator-iverilog-wasm/test/virtualWorkspace.test.ts`
- Test: `packages/simulator-iverilog-wasm/test/artifactWriter.test.ts`

**Step 1: Write failing path and artifact tests**

Cover:

- files under `cwd` map to `workspace/<relative-path>`;
- each include root maps to `libraries/<index>/<relative-path>`;
- the longest matching configured root wins;
- external source files map to stable hashed directories;
- Windows drive letters and separators become valid POSIX virtual paths;
- duplicate logical paths fail before execution;
- dependency-ordered source order is preserved;
- runtime data files are copied but are not compiler sources;
- artifact paths reject absolute paths, `..`, NUL, and the reserved `.iverilog` prefix;
- artifact destinations may be absolute but are written only from explicitly requested names; and
- partial artifact writes are cleaned on abort or failure.

**Step 2: Run and observe failure**

Run `npm test --workspace @veriflow/simulator-iverilog-wasm`.

Expected: FAIL because workspace and writer helpers are absent.

**Step 3: Implement deterministic mapping**

Use SHA-256 of the normalized external parent directory for external namespaces; never use random IDs. Read each host file once and return:

```ts
export interface VirtualWorkspace {
    files: Array<{ path: string; data: Uint8Array }>;
    sources: string[];
    includeDirs: string[];
    hostPathByVirtualPath: ReadonlyMap<string, string>;
}
```

Do not recursively copy an entire library directory. Only copy dependency-resolved sources/includes plus explicit `simulationFiles`.

**Step 4: Implement atomic artifact writes**

Write to a uniquely named sibling temporary file, `fsync`/close it, then rename it to the destination. Remove the temporary file on any error. Never interpret artifact bytes as text.

**Step 5: Run tests and commit**

Run the adapter workspace tests; expect PASS.

```bash
git add packages/simulator-iverilog-wasm
git commit -m "feat(sim): map host files into isolated wasm workspaces"
```

## Task 8: Implement The Built-In Backend

**Files:**
- Create: `packages/simulator-iverilog-wasm/src/iverilogWasmBackend.ts`
- Modify: `packages/simulator-iverilog-wasm/src/index.ts`
- Test: `packages/simulator-iverilog-wasm/test/iverilogWasmBackend.test.ts`
- Create: `packages/simulator-iverilog-wasm/test/fixtures/counter.v`
- Create: `packages/simulator-iverilog-wasm/test/fixtures/compile-error.v`
- Create: `packages/simulator-iverilog-wasm/test/fixtures/infinite.v`

**Step 1: Write failing backend tests**

Test a fake injected API first, then the real package. Cover:

- generation is always `2005`;
- top, defines, include roots, plusargs, timeout, and signal are forwarded;
- stage/timing fields map without combining compile and run incorrectly;
- compiler diagnostics map virtual paths back to host paths;
- a requested VCD is written and reported;
- a missing optional VCD returns `waveFile: null`;
- a missing required artifact fails the artifact stage;
- invalid HDL resolves as compile/run failure rather than throwing infrastructure error;
- worker start, protocol, timeout, trap, and abort errors become infrastructure-stage failures; and
- no failure invokes native Icarus.

**Step 2: Run and verify failure**

Run `npm test --workspace @veriflow/simulator-iverilog-wasm`.

Expected: FAIL because `IverilogWasmBackend` is absent.

**Step 3: Implement the backend**

The central call must remain one engine:

```ts
const result = await api.simulate({
    files: workspace.files,
    sources: workspace.sources,
    includeDirs: workspace.includeDirs,
    generation: '2005',
    top: request.topModule,
    defines: request.defines,
    plusargs: request.plusargs,
    artifacts: request.artifacts.map(artifact => artifact.path),
    timeoutMs: request.timeoutMs,
    signal: request.signal,
});
```

Only write returned artifacts after `simulate()` settles. Preserve artifacts produced before an expected HDL runtime failure, as supported by the upstream API.

**Step 4: Run fake and real tests**

Run:

```bash
npm test --workspace @veriflow/simulator-iverilog-wasm
```

Expected: PASS. The real counter prints `PASS`; abort returns within the test timeout; VCD bytes are non-empty.

**Step 5: Commit**

```bash
git add packages/simulator-iverilog-wasm
git commit -m "feat(sim): implement builtin Icarus WASM backend"
```

## Task 9: Route The CLI Through The Backend Registry

**Files:**
- Create: `packages/cli/src/runtime/simulationBackends.ts`
- Modify: `packages/cli/src/commands/sim.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json`
- Test: `packages/cli/test/cliContract.test.ts`
- Create: `packages/cli/test/builtinSimulation.test.ts`

**Step 1: Write failing CLI tests**

Add contract cases for:

- a new project selecting `builtin`;
- explicit `--sim native-iverilog`;
- legacy `--sim iverilog` retaining command execution;
- unknown backend failure;
- `experimental-ts` unavailable failure with zero builtin/native calls;
- defines, library roots, `simulation_files`, plusargs, timeout, and VCD artifact request;
- SIGINT aborting dependency scan or simulation through the same signal; and
- command logging only for native backends.

The real smoke test must create a `.v` counter/testbench, run `runCli(['sim', ...])` with `builtin`, assert `PASS`, and assert the VCD destination exists.

**Step 2: Run and verify failures**

Run `npm test --workspace @veriflow/cli`.

Expected: FAIL because CLI always constructs `NativeSimulatorBackend`.

**Step 3: Build the host registry**

`createCliSimulationBackends()` registers:

- `builtin` -> `IverilogWasmBackend`;
- `native-iverilog` -> native backend using `project.simulators['native-iverilog']` or the default;
- `iverilog`, `vcs`, `xsim`, `custom`, and configured custom IDs -> native backend with the matching command template;
- `experimental-ts` -> an explicit unavailable provider until Task 15's product gate is met.

Do not register an alias by catching a backend failure. Resolve aliases before execution.

**Step 4: Pass the simulation signal**

Reuse the existing `AbortController` for scanning and simulation. Keep the SIGINT listener installed until simulation and host disposal finish.

**Step 5: Run tests and commit**

Run:

```bash
npm test --workspace @veriflow/cli
```

Expected: PASS, including the real WASM smoke without native `iverilog` in `PATH`.

```bash
git add packages/cli
git commit -m "feat(cli): use builtin simulation backend registry"
```

## Task 10: Replace VS Code's Synchronous Simulation Path

**Files:**
- Create: `veriflow-vscode/src/core/simulationService.ts`
- Create: `veriflow-vscode/src/core/externalWaveViewerLauncher.ts`
- Modify: `veriflow-vscode/src/core/index.ts`
- Delete: `veriflow-vscode/src/core/simulationRunner.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/config.ts`
- Modify: `veriflow-vscode/package.json`
- Test: `veriflow-vscode/src/test/core.test.ts`
- Test: `veriflow-vscode/src/test/hdlConfig.test.ts`
- Test: `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`
- Test: `veriflow-vscode/src/test/extensionDependencyIndex.test.ts`

**Step 1: Write failing service and configuration tests**

Test that:

- no extension simulation code imports or calls `execSync`;
- `SimulationService.run()` awaits the selected backend;
- a second run aborts the first run;
- deactivate aborts the active run;
- VS Code cancellation token aborts the request;
- stale lifecycle generations cannot publish output or state;
- `builtin`, `native-iverilog`, `experimental-ts`, and legacy IDs are accepted;
- the settings default is `builtin`;
- explicit `iverilog` remains native; and
- wave-viewer process launching remains separate from simulation.

**Step 2: Run and verify failures**

Run:

```bash
npm run compile:ts --workspace veriflow-vscode
node veriflow-vscode/out/test/core.test.js
node veriflow-vscode/out/test/hdlConfig.test.js
node veriflow-vscode/out/test/hdlFeatureMigration.test.js
```

Expected: FAIL because `SimulationRunner` is synchronous and settings default to `iverilog`.

**Step 3: Implement the async service**

`SimulationService` owns the active `AbortController`, creates a request with dependency-ordered files and configured resources, calls the registry once, and clears the active controller in `finally` only if it still owns it.

Use `vscode.window.withProgress({ cancellable: true })` around the run. Connect its token to the request controller. Do not block the extension host.

**Step 4: Migrate extension state**

Replace `simulateProcess` and the global `simRunner` with the service and a separate external wave viewer launcher. Keep lifecycle-generation checks before and after every awaited operation.

For VS Code, build a VCD request from `waveFileTemplate`:

```ts
{
    kind: 'vcd',
    path: toWorkspaceRelativePosixPath(root, waveFile),
    destination: waveFile,
    required: false,
}
```

If a built-in artifact path lies outside the workspace, report a configuration error before simulation. Do not rewrite `$dumpfile` text.

**Step 5: Update settings**

Set the enum order to:

```json
["builtin", "native-iverilog", "experimental-ts", "iverilog", "vcs", "xsim", "custom"]
```

Set default to `builtin`. Describe `experimental-ts` as incomplete and opt-in. Keep custom command settings.

**Step 6: Run focused and full extension tests**

Run:

```bash
npm test --workspace veriflow-vscode
```

Expected: PASS; a source scan for `execSync` finds no simulation use.

**Step 7: Commit**

```bash
git add veriflow-vscode
git commit -m "feat(vscode): run simulation asynchronously through backends"
```

## Task 11: Package The ESM Worker And WASM Assets In The VSIX

**Files:**
- Modify: `veriflow-vscode/scripts/build.mjs`
- Modify: `veriflow-vscode/scripts/build-support.mjs`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `veriflow-vscode/THIRD_PARTY_NOTICES.md`
- Modify: `veriflow-vscode/src/test/vsixPackaging.test.ts`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Create: `veriflow-vscode/src/test/builtinSimulatorAssets.test.ts`

**Step 1: Write failing asset tests**

Extend expected VSIX entries with:

```text
extension/dist/vendor/iverilog-wasm/package.json
extension/dist/vendor/iverilog-wasm/LICENSE
extension/dist/vendor/iverilog-wasm/dist/SOURCE.md
extension/dist/vendor/iverilog-wasm/dist/index.js
extension/dist/vendor/iverilog-wasm/dist/worker.js
extension/dist/vendor/iverilog-wasm/dist/runtime/ivl.mjs
extension/dist/vendor/iverilog-wasm/dist/runtime/ivl.wasm
extension/dist/vendor/iverilog-wasm/dist/runtime/ivlpp.mjs
extension/dist/vendor/iverilog-wasm/dist/runtime/ivlpp.wasm
extension/dist/vendor/iverilog-wasm/dist/runtime/vvp.mjs
extension/dist/vendor/iverilog-wasm/dist/runtime/vvp.wasm
```

Extract the VSIX, dynamically import the packaged `dist/index.js` by file URL, run the counter, and verify nonblank VCD output. Also assert the extension bundle does not contain base64/inlined WASM payloads.

**Step 2: Run and verify failure**

Run:

```bash
npm run package --workspace veriflow-vscode -- --out /tmp/veriflow-sim-plan.vsix
npm test --workspace veriflow-vscode
```

Expected: FAIL because vendor assets are absent.

**Step 3: Copy the package verbatim**

Resolve the ESM entry with `import.meta.resolve('@veriflow/iverilog-wasm')`, walk from `dist/index.js` to the package root, verify package version `0.1.1`, and copy only declared package files to `dist/vendor/iverilog-wasm`. Preserve modes and relative layout. A CommonJS `require.resolve()` is not valid here because the upstream package intentionally has no `require` export. Never pass these generated runtime files through esbuild.

Pass a trusted file URL for `dist/vendor/iverilog-wasm/dist/index.js` to `IverilogWasmBackend` when constructing the VS Code registry.

**Step 4: Extend third-party notice generation**

Add explicit runtime-package collection because the external ESM package is not present in esbuild's metafile. Include its declared GPL license, full `LICENSE`, exact version, and `dist/SOURCE.md` provenance.

Fail the build if version, license, source metadata, worker, or any WASM file is missing.

**Step 5: Run packaging tests on current and oldest Node baselines**

Run:

```bash
npm test --workspace veriflow-vscode
npx --yes node@18.15.0 veriflow-vscode/out/test/builtinSimulatorAssets.test.js
```

Expected: PASS. The simulation runs from the extracted VSIX path, proving `import.meta.url` resolves the copied worker and runtime assets.

**Step 6: Commit**

```bash
git add veriflow-vscode
git commit -m "build(vscode): package Icarus worker and wasm assets"
```

## Task 12: Complete Node Packaging And GPL Release Metadata

**Files:**
- Modify: `scripts/pack-node-release.mjs`
- Modify: `scripts/test-node-release.mjs`
- Create: `scripts/lib/iverilog-source.mjs`
- Create: `scripts/lib/iverilog-source.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `docs/licenses/iverilog-wasm.md`
- Modify: `packages/cli/package.json`
- Modify: `veriflow-vscode/package.json`

**Step 1: Add failing clean-install assertions**

Add `@veriflow/simulator-iverilog-wasm` to the publishable workspace list and require its compiled entry in the tarball. Install all VeriFlow tarballs into a temporary directory, run the CLI `builtin` smoke with `PATH` stripped of native Icarus, and verify the installed upstream package contains `LICENSE` and `dist/SOURCE.md`.

Run `npm run test:release`.

Expected: FAIL because the adapter is not packed and the CLI smoke does not run built-in simulation.

**Step 2: Add source-provenance validation**

`scripts/lib/iverilog-source.mjs` must read the installed `dist/SOURCE.md`, extract and validate the HTTPS repository URL and exact 40-character revision, and reject placeholders or a version mismatch. Tests use local fixture metadata; they must not depend on network access.

**Step 3: Add release-source delivery**

During tagged release:

1. Resolve the pinned upstream revision from the installed package.
2. Clone that exact revision with tags disabled.
3. Create `iverilog-wasm-source-<revision>.tar.gz` including build scripts and submodules if any.
4. Upload it beside npm tarballs and the VSIX.
5. Include it in `SHA256SUMS.txt`.

The npm and VSIX artifacts must retain `SOURCE.md` pointing to the same revision. Treat legal review of the final distribution as a release gate.

**Step 4: Run release verification**

Run:

```bash
node --test scripts/lib/iverilog-source.test.mjs
npm run test:release
npm run pack:node
npm run package --workspace veriflow-vscode
```

Expected: PASS. The local non-tag build may skip network source-archive creation, but metadata validation must run.

**Step 5: Commit**

```bash
git add scripts packages/cli veriflow-vscode docs/licenses .github/workflows
git commit -m "build(sim): enforce wasm licensing and clean installs"
```

## Task 13: Add The 1,758-Case Regression Bridge

**Files:**
- Create: `tools/simulation/iverilog-revision.json`
- Create: `scripts/simulation/read-iverilog-regress.mjs`
- Create: `scripts/simulation/read-iverilog-regress.test.mjs`
- Create: `scripts/simulation/result-normalizer.mjs`
- Create: `scripts/simulation/result-normalizer.test.mjs`
- Create: `scripts/simulation/run-iverilog-regression.mjs`
- Create: `docs/simulation/iverilog-regression.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write manifest parser tests**

Cover active/commented entries, normal/CE/RE cases, comma-separated options, `gold=`, source directories, and explicit generations. The generated manifest must contain no copied HDL source.

**Step 2: Run and verify failure**

Run:

```bash
node --test scripts/simulation/read-iverilog-regress.test.mjs
```

Expected: FAIL because the parser is absent.

**Step 3: Implement and assert the pinned counts**

Run:

```bash
node scripts/simulation/read-iverilog-regress.mjs \
  --iverilog-root /home/mercer/prj/iverilog \
  --output /tmp/veriflow-regress-manifest.json
```

Expected: summary reports 1,766 active and 1,758 eligible entries. The eight excluded entries must name their explicit non-2005 generation reason.

**Step 4: Add result normalization and runner tests**

Normalize line endings, configured root prefixes, and declared nondeterministic timing text only. Preserve stdout order, diagnostic text, exit class, and unexpected files. A native/WASM mismatch must remain a mismatch until documented.

**Step 5: Run a deterministic shard**

Run:

```bash
npm run test:sim-regression -- \
  --iverilog-root /home/mercer/prj/iverilog \
  --backend native-iverilog,builtin \
  --shard 0/20 \
  --json /tmp/veriflow-regress-results.json
```

Expected: runner completes and reports pass/fail/skip per backend. Investigate mismatches; do not add broad output filters.

**Step 6: Add CI and commit**

Add the deterministic shard to pull-request CI and a full 1,758-case scheduled job. Archive result JSON.

```bash
git add tools/simulation scripts/simulation docs/simulation package.json .github/workflows/ci.yml
git commit -m "test(sim): add Verilog-2005 regression bridge"
```

## Task 14: Establish Native VVP Performance Baselines

**Files:**
- Create: `benchmarks/verilog-simulator/README.md`
- Create: `benchmarks/verilog-simulator/cases/counter/`
- Create: `benchmarks/verilog-simulator/cases/arithmetic/`
- Create: `benchmarks/verilog-simulator/cases/uart/`
- Create: `benchmarks/verilog-simulator/cases/fifo/`
- Create: `benchmarks/verilog-simulator/cases/generate/`
- Create: `benchmarks/verilog-simulator/cases/memory/`
- Create: `benchmarks/verilog-simulator/cases/wide-vector/`
- Create: `benchmarks/verilog-simulator/cases/multi-driver/`
- Create: `benchmarks/verilog-simulator/cases/udp/`
- Create: `benchmarks/verilog-simulator/cases/specify/`
- Create: `benchmarks/verilog-simulator/cases/vcd-heavy/`
- Create: `scripts/simulation/benchmark.mjs`
- Create: `scripts/simulation/benchmark.test.mjs`
- Modify: `package.json`

**Step 1: Test the harness before adding measurements**

Use fake backends and a fake monotonic clock to test warmup exclusion, five-sample median, p95, compile/run separation, timeout, failure, and JSON schema.

Run `node --test scripts/simulation/benchmark.test.mjs`.

Expected: FAIL because the harness is absent.

**Step 2: Implement the benchmark protocol**

For native Icarus, compile once with `iverilog -g2005`, then measure `vvp` only. For WASM, call `compile()` once and measure `run()` only. Preserve a separate end-to-end metric for user-perceived latency.

Do not compare native compile+run against WASM run-only.

**Step 3: Add project-authored benchmark cases**

Each case includes a deterministic self-check and a bounded completion condition. Keep no-I/O and VCD variants separate. Document expected event counts where practical.

**Step 4: Capture the baseline**

Run:

```bash
npm run benchmark:sim -- \
  --backend native-iverilog,builtin \
  --samples 5 \
  --json /tmp/veriflow-simulator-benchmark.json
```

Expected: JSON contains platform, CPU, Node, backend versions, compile time, run median/p95, peak RSS, VCD bytes, and success for every case.

**Step 5: Commit**

```bash
git add benchmarks/verilog-simulator scripts/simulation package.json
git commit -m "perf(sim): add native vvp comparison harness"
```

## Task 15: Start The TypeScript Simulator With A Measured Core

**Files:**
- Create: `packages/simulator-ts/package.json`
- Create: `packages/simulator-ts/tsconfig.json`
- Create: `packages/simulator-ts/tsconfig.test.json`
- Create: `packages/simulator-ts/src/index.ts`
- Create: `packages/simulator-ts/src/diagnostics.ts`
- Create: `packages/simulator-ts/src/fourStateVector.ts`
- Create: `packages/simulator-ts/test/fourStateVector.test.ts`
- Create: `packages/simulator-ts/test/backendAvailability.test.ts`
- Create: `packages/simulator-ts/benchmark/fourStateVector.mjs`
- Modify: `package.json`

**Step 1: Create a private experimental workspace**

Set `private: true`. Do not add it to `scripts/pack-node-release.mjs` and do not register it as a runnable product backend yet.

**Step 2: Write exhaustive failing four-state tests**

Test 1-bit truth tables for `~`, `&`, `|`, `^`, logical equality, case equality, conditional merge, reductions, and edge classification. Add 32-bit and wide-limb tests for width, signed extension, slicing, concatenation, and unknown-mask propagation.

Use paired value/unknown masks for widths <=32 and fixed `Uint32Array` limbs for wider values. `BigInt` is permitted in test or constant-oracle code, not as the default runtime signal storage.

Run:

```bash
npm test --workspace @veriflow/simulator-ts
```

Expected: FAIL because the vector implementation is absent.

**Step 3: Implement the minimal value core**

Keep the public API immutable and avoid allocations in mutating hot-path helpers. Distinguish X and Z where operations require it; do not collapse both into a single unknown bit if that loses case equality or net-resolution information.

**Step 4: Add a microbenchmark**

Measure scalar and 32-bit assignment, bitwise operations, equality, and wide-vector copying. Compare representation variants, not against `vvp`; this benchmark chooses the TS data layout before scheduler work begins.

Run:

```bash
npm test --workspace @veriflow/simulator-ts
node packages/simulator-ts/benchmark/fourStateVector.mjs
```

Expected: tests PASS and benchmark emits JSON without asserting unstable wall-time thresholds.

**Step 5: Keep product selection explicit and unavailable**

Until preprocessing, semantic AST, elaboration, and scheduler vertical-slice plans are complete, selecting `experimental-ts` in CLI or VS Code returns:

```text
experimental-ts is not available in this build; no fallback was attempted
```

Add a test proving zero calls to `builtin` and native providers.

**Step 6: Commit**

```bash
git add packages/simulator-ts package.json package-lock.json
git commit -m "feat(sim-ts): establish four-state value core"
```

## Task 16: Final Integration, Documentation, And CI Gates

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `veriflow-vscode/README.md`
- Modify: `veriflow-vscode/README_zh-CN.md`
- Modify: `veriflow-vscode/CHANGELOG.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/DECISIONS.md` only if implementation discovers a decision-level change

**Step 1: Document backend behavior**

Document IDs, defaults, legacy alias behavior, Verilog-2005 scope, no SystemVerilog guarantee for `experimental-ts`, cancellation, runtime data files, VCD path limits, Node requirements, and GPL source access. State clearly that no fallback occurs.

**Step 2: Run the complete verification from a clean install**

Run:

```bash
npm ci
npm run typecheck:shared
npm run test:shared
npm test --workspace @veriflow/simulator-iverilog-wasm
npm test --workspace @veriflow/simulator-ts
npm test --workspace @veriflow/cli
npm test --workspace veriflow-vscode
npm run test:release
npm run pack:node
npm run package --workspace veriflow-vscode
git diff --check
```

Expected: every command exits 0.

**Step 3: Run platform smoke tests**

CI must run built-in CLI and extracted-VSIX simulation on Linux, macOS, and Windows. At least one job uses the oldest supported extension-host Node runtime. Native reference tests may skip only when `iverilog` is intentionally absent; built-in tests never skip because native Icarus is missing.

**Step 4: Review release artifacts**

Verify:

- npm adapter tarball depends on exactly `@veriflow/iverilog-wasm@0.1.1`;
- CLI clean install simulates without native executables;
- VSIX includes ESM, worker, all WASM binaries, `LICENSE`, and `SOURCE.md`;
- generated checksums include the Icarus source archive;
- third-party notices name the exact package version and GPL license;
- no source, test, build-root path, or unrequested generated artifact leaked into packages; and
- `experimental-ts` remains unavailable rather than silently using Icarus.

**Step 5: Request code review**

Use `superpowers:requesting-code-review` with special attention to:

- CommonJS/ESM and worker URL behavior;
- cancellation races and listener cleanup;
- virtual-path collisions and artifact traversal;
- result-stage/error classification;
- legacy project and simulator behavior;
- GPL source delivery; and
- correctness/performance tests that could accidentally normalize real semantic differences.

**Step 6: Commit final documentation**

```bash
git add README.md packages/cli/README.md veriflow-vscode docs .github/workflows
git commit -m "docs(sim): document builtin Verilog-2005 simulation"
```

## Completion Criteria

Phase 1 and the immediate foundation are complete only when all of the following are true:

- `builtin` performs a real Verilog-2005 simulation in both hosts without native Icarus.
- `native-iverilog` remains available and explicit `iverilog` projects keep native behavior.
- `experimental-ts` never falls back and remains gated until its compiler/runtime is real.
- Abort and timeout terminate WASM workers and native processes without stale UI updates.
- VCD artifacts are returned through the common result and written only to requested destinations.
- The CommonJS/ESM boundary passes both direct and esbuild-bundled tests.
- The extracted VSIX passes a real runtime smoke from its final packaged paths.
- npm and VSIX artifacts contain license/source metadata required for the Icarus binary payload.
- The pinned corpus reports 1,758 eligible Verilog-2005 cases.
- Native `vvp` performance baselines exist before TypeScript scheduler optimization starts.
- The TypeScript workspace has tested four-state storage and remains private/experimental.

After these criteria pass, continue with the gate-driven TypeScript phases in `docs/plans/2026-08-16-verilog-2005-simulator-program.md`.

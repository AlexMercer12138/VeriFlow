# Verilog-2005 Simulator Program Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a stable zero-install Icarus WASM backend, retain native Icarus as the reference backend, and incrementally build a project-owned TypeScript Verilog-2005 simulator behind explicit correctness and performance gates.

**Architecture:** `@veriflow/flow-core` owns an engine-neutral asynchronous simulation contract and backend registry. Product hosts select exactly one backend for a run: `builtin` loads Icarus WASM, `native-iverilog` and legacy command-template IDs launch external processes, and `experimental-ts` loads the project-owned compiler/runtime when its release gate is met. Correctness, packaging, licensing, and performance are measured independently; no backend silently falls back to another engine.

**Tech Stack:** TypeScript 5.9, Node.js workers and child processes, Icarus Verilog/VVP WebAssembly, Tree-sitter Verilog/SystemVerilog grammar used as a CST only, Node test runner, esbuild, VS Code extension packaging, GitHub Actions.

---

## Program Rules

1. Target IEEE 1364-2005 only. SystemVerilog and external VPI/PLI are out of scope.
2. `builtin` remains a product identity. It resolves to Icarus WASM until a separate decision changes it.
3. One request uses one compiler, one elaborator, and one scheduler from start to finish.
4. The Icarus corpus is a differential oracle and compatibility source, not a substitute for the IEEE standard.
5. The TypeScript simulator is a clean implementation. Do not copy or translate Icarus implementation code.
6. A feature is not complete until CLI, VS Code, cancellation, artifact, clean-install, and license tests pass.
7. Performance work starts with measurement. Do not weaken four-state semantics to improve a benchmark.

## Baseline And Scope

| Item | Baseline |
| --- | --- |
| Stable backend | `builtin` -> `@veriflow/iverilog-wasm` |
| External reference | `native-iverilog` -> installed `iverilog` + `vvp` |
| Experimental backend | `experimental-ts` -> project-owned TypeScript engine |
| Language | IEEE 1364-2005 |
| Compatibility corpus | `ivtest/regress-vlg.list` at a pinned Icarus revision |
| Active corpus entries | 1,766 |
| Explicit non-2005 exclusions | 6 |
| Initial Verilog-2005 gate | 1,758 |
| Performance reference | Native `vvp`, measured separately from compilation |
| Default-change eligibility | >=95% corpus, median <=2x native `vvp`, ordinary RTL worst case <=5x unless accepted |

## Dependency Graph

```text
Icarus WASM runtime compatibility and release
                 |
                 v
shared contract + backend registry
        |                  |
        v                  v
Icarus WASM adapter    native backend migration
        |                  |
        +--------+---------+
                 v
          CLI + VS Code hosts
                 |
                 v
      packaging, GPL, clean installs
                 |
                 v
      native/WASM regression baseline
                 |
                 v
        TypeScript simulator phases
                 |
                 v
      compatibility/performance review
```

## Phase Schedule

The ranges below are engineering estimates for one experienced engineer with review support. They are planning ranges, not release promises.

| Phase | Deliverable | Estimate | Exit gate |
| --- | --- | --- | --- |
| 1 | Productize Icarus WASM | 4-6 weeks | Built-in simulation works in CLI and VS Code on clean Linux, macOS, and Windows installs |
| 2 | Regression and performance bridge | 3-5 weeks | 1,758-case manifest is reproducible; native/WASM baseline and benchmark JSON are archived |
| 3A | TS front end and elaboration | 3-5 engineer-months | Preprocessor, semantic AST, hierarchy, parameters, and generate pass their capability gates |
| 3B | TS common RTL runtime | 4-7 engineer-months | Four-state expressions, processes, NBA, delays, memories, VCD, and core system tasks run useful RTL |
| 4 | Full Verilog-2005 compatibility | 8-14 engineer-months | UDP, strength, tran, force/release, specify, timing checks, and SDF gaps are classified and closed |
| 5 | Default eligibility review | 2-4 weeks | Correctness, performance, memory, packaging, and real-project gates are independently approved |

Parallel staffing can shorten calendar time after the semantic AST and runtime IR contracts stabilize. Adding engineers before those contracts stabilize increases integration cost and is not assumed in the estimates.

## Phase 1: Productize Icarus WASM

Detailed task-by-task instructions are in:

- `docs/plans/2026-08-16-icarus-wasm-backend-implementation.md`

### Required Deliverables

- A published and exactly pinned `@veriflow/iverilog-wasm` release whose actual Node runtime range includes the supported VS Code extension host.
- A CommonJS-safe adapter boundary that preserves native dynamic `import()` of the ESM package.
- An asynchronous simulation contract with timeout, abort, defines, include roots, runtime data files, stage timings, and requested artifacts.
- A backend registry with explicit selection and legacy aliases.
- Shared CLI and VS Code execution through that registry.
- VCD artifact copying that never writes outside approved host paths.
- Clean npm and VSIX packaging tests that execute a real built-in simulation.
- GPL notices, exact source revision, reproducible build instructions, and release-source handling.

### Phase 1 Gate

Run:

```bash
npm run typecheck:shared
npm run test:shared
npm test --workspace @veriflow/simulator-iverilog-wasm
npm test --workspace @veriflow/cli
npm test --workspace veriflow-vscode
npm run test:release
npm run pack:node
npm run package --workspace veriflow-vscode
```

Expected: all commands exit 0. Clean-install smoke tests must run the same Verilog-2005 counter under `builtin` and `native-iverilog` when native Icarus is available. The VSIX inspection must find the Icarus ESM entry, worker, WASM files, `LICENSE`, and `dist/SOURCE.md` at their runtime paths.

## Phase 2: Regression And Performance Bridge

### Task 1: Pin The External Corpus

**Files:**
- Create: `tools/simulation/iverilog-revision.json`
- Create: `scripts/simulation/read-iverilog-regress.mjs`
- Create: `scripts/simulation/read-iverilog-regress.test.mjs`
- Modify: `package.json`

**Steps:**

1. Write parser tests for normal, compile-error, runtime-error, gold-file, option, and commented entries.
2. Add a fixture containing all language-generation exclusion forms.
3. Run `node --test scripts/simulation/read-iverilog-regress.test.mjs`; expect parser and count assertions to fail.
4. Implement normalized manifest parsing without copying test source files.
5. Run the parser against `/home/mercer/prj/iverilog/ivtest/regress-vlg.list`.
6. Assert 1,766 active entries and 1,758 eligible Verilog-2005 entries at the pinned revision.
7. Commit with `test(sim): pin Icarus Verilog-2005 corpus`.

### Task 2: Establish Native/WASM Differential Results

**Files:**
- Create: `scripts/simulation/run-iverilog-regression.mjs`
- Create: `scripts/simulation/result-normalizer.mjs`
- Create: `scripts/simulation/result-normalizer.test.mjs`
- Create: `docs/simulation/iverilog-regression.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

**Steps:**

1. Test normalization of paths, line endings, timing noise, and expected-error result classes.
2. Add explicit capability labels for external VPI/PLI, unsupported generations, VHDL, and environment-specific tests.
3. Run a 20-case deterministic shard under native and WASM Icarus; expect the first run to reveal normalization gaps.
4. Fix normalization only for documented nondeterminism. Do not mask semantic output differences.
5. Add `npm run test:sim-regression -- --backend native-iverilog,builtin --shard 0/20` to CI.
6. Archive JSON results containing Icarus revision, package version, backend, platform, pass/fail/skip counts, and per-case duration.
7. Expand scheduled CI to the full 1,758-case set after three consecutive deterministic shard runs.
8. Commit with `test(sim): add native and wasm regression bridge`.

### Task 3: Create The Performance Baseline

**Files:**
- Create: `benchmarks/verilog-simulator/README.md`
- Create: `benchmarks/verilog-simulator/cases/`
- Create: `scripts/simulation/benchmark.mjs`
- Create: `scripts/simulation/benchmark.test.mjs`
- Modify: `package.json`

**Steps:**

1. Add project-authored cases for counters, combinational arithmetic, UART, FIFO, generate, memories, wide vectors, multi-driver nets, UDP, specify timing, and VCD-heavy output.
2. Test the benchmark runner with a fake backend and deterministic clock.
3. Measure compile and run separately. Warm each engine once and report at least five measured samples.
4. Record median, p95, peak RSS, trace bytes, and event counters when the backend exposes them.
5. Add `npm run benchmark:sim -- --backend native-iverilog,builtin --json <path>`.
6. Keep performance CI informational until machine variance and thresholds are calibrated.
7. Commit with `perf(sim): establish native vvp baseline`.

## Phase 3A: TypeScript Front End And Elaboration

Create a separate detailed plan before each milestone. Use these ordered gates:

1. `TS-PREPROCESS`: complete Verilog-2005 macros, include handling, conditionals, directives, and source maps.
2. `TS-AST`: Tree-sitter CST lowers to a typed semantic AST; no raw CST nodes cross the worker boundary.
3. `TS-CONST`: sized/signed/four-state constants and constant expressions match portable corpus expectations.
4. `TS-SCOPE`: modules, functions, tasks, named blocks, hierarchical references, and timescales resolve.
5. `TS-ELAB`: parameter overrides, port binding, arrays, generate, defparam, and primitive instances elaborate to immutable design IR.

Each gate must include unit tests, focused Icarus differential tests, corpus capability counts, diagnostics with original source spans, resource limits, and a saved benchmark comparison. `experimental-ts` remains opt-in and may report a structured unsupported-capability diagnostic; it must never rerun under `builtin`.

## Phase 3B: TypeScript Common RTL Runtime

Implement in this order:

1. Four-state scalar and vector storage with signedness and width rules.
2. Expression and lvalue evaluation, including concatenation, part-select, and memory access.
3. Dense signal/process IDs and immutable SimIR.
4. Active, inactive, nonblocking-assignment, monitor, and future-time queues.
5. Resumable `initial`/`always` processes, event controls, delays, loops, functions, and tasks.
6. Continuous assignments, net drivers, edge detection, and common wire resolution.
7. `$display`, `$write`, `$strobe`, `$monitor`, `$finish`, `$stop`, time formatting, and memory loading.
8. Buffered VCD generation with bounded transfer and backpressure.

### Common RTL Gate

- Every supported construct has direct four-state and scheduling tests.
- Zero-delay oscillation terminates with a structured diagnostic naming active processes and signals.
- At least 70% of the 1,758-case corpus passes; every remaining case has a capability label.
- The common RTL benchmark subset is measured against native `vvp`; regressions over 10x require investigation before adding more language surface.
- CLI and VS Code expose `experimental-ts` only with an experimental label and no fallback.

## Phase 4: Complete Verilog-2005 Compatibility

Create separate implementation plans for these capability groups:

1. User-defined primitives and sequential UDP tables.
2. Drive strength, charge strength, wired nets, trireg, and resolution.
3. Bidirectional tran/rtran/tranif/cmos networks.
4. Force/release and procedural continuous assignment.
5. Specify paths, timing checks, pulse rejection, and notifier behavior.
6. SDF annotation required by the selected Verilog-2005 corpus.
7. Remaining file I/O and standard system tasks/functions.

Do not force rare features into the common RTL representation. Use slower general paths with explicit capability and performance tests.

### Full Compatibility Gate

- >=95% of the 1,758 eligible cases pass.
- No release-blocking divergence remains in ordinary RTL.
- Every skip is tied to an issue, capability, and standard clause.
- Native, WASM, and TS result reports retain raw output for disputed cases.
- An independent review samples passes, failures, skips, and intentional Icarus differences.

## Phase 5: Default Eligibility Review

### Task 1: Freeze Candidate Builds

Record exact VeriFlow, Icarus WASM, native Icarus, Node, VS Code, OS, and benchmark revisions. Re-run correctness and performance from clean installations.

### Task 2: Apply Performance Gates

- Median no-VCD simulation time <=2x native `vvp`.
- No ordinary RTL benchmark >5x native `vvp` without an accepted written exception.
- VCD-enabled wall time, peak memory, and artifact size stay within release budgets.
- Long-running and zero-delay cases obey timeout, abort, event, delta-cycle, and output limits.

### Task 3: Record The Product Decision

If all gates pass, write a new entry in `docs/DECISIONS.md` deciding whether `builtin` changes implementation. Passing gates makes the TS backend eligible; it does not automatically change the default.

## Ongoing Reporting

Every simulation milestone publishes one JSON report with:

- source and tool revisions;
- total/pass/fail/skip counts by capability;
- new regressions since the last accepted baseline;
- compile and run performance separately;
- peak memory and artifact sizes;
- known Icarus deviations and standard references; and
- the next gate and its unresolved blockers.

Store generated reports as CI artifacts, not committed repository churn. Commit only stable fixtures, parsers, benchmark sources, thresholds, and summarized accepted baselines.

## Program Stop Conditions

Pause and record a new decision if any of these occurs:

- the Icarus WASM runtime cannot support the extension host's Node version without an unsafe fork;
- GPL source-delivery requirements cannot be met by npm, VSIX, and GitHub release workflows;
- the selected parser cannot preserve the source mapping or grammar distinctions required by Verilog-2005;
- a runtime representation makes ordinary RTL miss the 5x gate before uncommon features are added; or
- full Verilog-2005 scope materially exceeds the accepted compatibility or staffing budget.

These are architecture review triggers, not permission to add silent fallback or reduce semantic correctness.

# Verilog-2005 Simulator Backends Design

**Date:** 2026-08-16

**Status:** Confirmed

## Summary

VeriFlow will provide a zero-install, stable simulation path through the
existing `@veriflow/iverilog-wasm` package while developing a project-owned
TypeScript simulator as a separate experimental backend. Native Icarus remains
available as an external backend and serves as the primary performance
reference.

The TypeScript simulator targets IEEE 1364-2005. It does not support
SystemVerilog or external VPI/PLI. Its compatibility program uses the standard
Verilog cases in Icarus `ivtest/regress-vlg.list`, filtered to exclude tests
that explicitly request a different language generation. The engines share a
host-neutral asynchronous product contract, but one simulation always uses one
engine from compilation through completion. VeriFlow never silently falls back
or mixes schedulers.

## Goals

- Provide a built-in simulator that requires no native Icarus installation.
- Make Icarus WASM the dependable default while TypeScript coverage grows.
- Implement a clean, independently maintained IEEE 1364-2005 compiler and
  event-driven runtime in TypeScript.
- Reach native Icarus `vvp` performance for ordinary synthesizable RTL and
  remain within defined bounds for uncommon standard features.
- Reuse one simulation workflow across the CLI and VS Code extension.
- Preserve the current VCD viewing pipeline and structured log presentation.
- Measure language compatibility and runtime performance independently.

## Non-Goals

- SystemVerilog parsing, elaboration, or simulation.
- External VPI or PLI modules, cocotb integration, or a compatible plugin ABI.
- VHDL, Verilog-AMS, mixed-language, or mixed-signal simulation.
- FST, LXT, or LXT2 output in the TypeScript backend.
- SDF tooling beyond the Verilog-2005 annotation behavior needed by the
  selected regression corpus.
- Transparent per-file or per-construct fallback between simulation engines.
- Porting or translating Icarus C/C++ implementation code into TypeScript.

## Backend Roles

VeriFlow exposes three logical simulator backends:

| Backend ID | Role | Stability |
| --- | --- | --- |
| `builtin` | Icarus WebAssembly compiler and VVP runtime | Default and stable |
| `native-iverilog` | User-installed `iverilog` and `vvp` executables | External reference |
| `experimental-ts` | Project-owned Verilog-2005 simulator | Explicit opt-in |

`builtin` is a product identity rather than an implementation promise. It
initially resolves to Icarus WASM. Replacing it with the TypeScript backend
requires the release gates in this document and a separate recorded decision.
Users selecting `experimental-ts` receive its own diagnostics and unsupported
feature errors; VeriFlow does not rerun a failed design under Icarus.

## Product Architecture

`@veriflow/flow-core` continues to own the host-neutral simulation contract.
The contract must describe source inputs, defines, include directories, top
selection, output artifacts, cancellation, timeout, and stage timings without
assuming shell commands. Command-template configuration remains an adapter for
external simulators rather than the common model.

```text
CLI / VS Code
      |
      v
simulation backend registry
      |
      +-- builtin ----------> @veriflow/iverilog-wasm worker
      +-- native-iverilog --> native child processes
      `-- experimental-ts --> TypeScript simulation worker
                                  |
                                  v
                         stdout, diagnostics, VCD
```

Both product hosts use the same asynchronous backend registry. The VS Code
extension must not retain a synchronous `execSync` simulation path. Simulation
runs outside the extension host and CLI control thread, and every backend
supports bounded cancellation and timeout behavior.

## Icarus WASM Backend

The stable backend adapts the existing Node package rather than exposing its
virtual filesystem to product code. VeriFlow reads the dependency-ordered
source set and required include or memory files, supplies generation `2005`,
and requests expected artifacts such as VCD output. The adapter writes returned
artifacts to approved host paths only after the worker finishes successfully.

Each request remains isolated in a worker with an in-memory filesystem. Worker
termination is the cleanup boundary for success, HDL failure, timeout, abort,
or a WebAssembly trap. Compiler and simulation output remain available for the
shared diagnostic parser.

The backend may cache successful VVP bytecode by a key containing source
content, source order, defines, include contents, top selection, Icarus source
revision, and compile options. Cached programs never bypass validation and are
invalidated by any participating input change. Runtime workers remain isolated
because the Icarus VVP runtime contains process-lifetime global state.

## TypeScript Compiler Pipeline

The current `HdlDocument` is an IDE and schematic model. It intentionally
stores procedural regions as opaque spans and expressions as coarse structural
summaries. The simulator must not execute expression text or expand that model
into an accidental runtime API.

The TypeScript backend introduces a separate compilation pipeline inside a
worker:

```text
Verilog sources
    -> complete Verilog-2005 preprocessing
    -> Tree-sitter CST
    -> typed semantic AST
    -> scope, constant, parameter, and generate elaboration
    -> flattened ElaboratedDesign
    -> compact SimIR and process state machines
    -> event-driven runtime
```

Raw Tree-sitter nodes remain worker-owned. Serializable diagnostics and an
immutable compiled artifact cross the worker boundary. Source spans survive
every lowering stage so compile and runtime errors point back to original files
after includes and macro expansion.

The preprocessor must implement object-like and function-like macros,
arguments, token pasting, stringification, conditional compilation, includes,
line directives, and compiler directives required by Verilog-2005. The current
structural preprocessor can supply source-map techniques but is not the
simulation preprocessor contract until it meets these semantics.

## TypeScript Runtime

The runtime uses four-state values and separates common RTL operations from
rare standard behavior. Signals and processes receive dense integer IDs during
elaboration. Hot-path storage uses preallocated typed arrays; runtime lookup
does not depend on source names, JavaScript maps, or per-event object creation.

Values up to 32 bits use paired value and unknown masks. Wider values use
fixed-size 32-bit limbs. `BigInt` is suitable for constant elaboration and
selected wide operations but is not the default signal representation. Net
resolution runs only when a driver changes.

The scheduler models the Verilog event regions required by IEEE 1364-2005,
including active, inactive, nonblocking assignment, monitor, and future-time
queues. Procedural blocks compile to resumable state machines. Static
sensitivity and dependency lists are precomputed whenever the language permits
it. Delayed assignments, named events, task calls, fork/join, force/release,
and procedural continuous assignment use explicit runtime instructions.

Ordinary registers, wires, continuous assignments, blocking and nonblocking
assignments, edge triggers, bit-vector operators, and memories use optimized
paths. UDPs, strengths, bidirectional transistor networks, specify timing,
timing checks, and SDF use slower general paths. Correct uncommon behavior must
not impose object-heavy representations on normal synchronous RTL.

## Trace And Output

VCD is the first trace format. Signal selection and hierarchy are resolved from
the elaborated design. Value changes enter a buffered trace sink rather than
performing a filesystem write in the scheduler hot path. The sink streams or
transfers bounded chunks to the host and applies backpressure without changing
simulation ordering.

`$display`, `$write`, `$strobe`, `$monitor`, `$finish`, `$stop`, file I/O,
memory loading, time formatting, and other selected Verilog-2005 system tasks
are explicit runtime services. Unsupported external VPI/PLI calls produce a
compile diagnostic instead of attempting host loading.

## Error And Resource Model

Errors have four classes:

1. Input and configuration errors reject the backend request before execution.
2. Preprocessing, parsing, and elaboration errors return a failed compile stage
   with source diagnostics.
3. Expected HDL runtime failures, including nonzero `$finish` and supported
   system-task failures, return a failed run stage with captured output.
4. Worker crashes, WebAssembly traps, protocol mismatches, timeouts, and memory
   limits return structured infrastructure errors.

Every backend applies limits to source bytes, include depth, generated scope
count, simulation time, delta cycles at one time point, event count, output
bytes, artifact bytes, and wall time. A repeated-delta limit reports the active
processes and signals involved in the suspected zero-delay oscillation.

## Compatibility Corpus

The baseline is the Icarus `ivtest/regress-vlg.list` file, which declares that
its cases target standard Verilog 1364-2005. The current list contains 1,766
active entries. Eight entries explicitly select `-g1`, `-g2`, `-g1995`,
`-g2001`, `-g2001-noconfig`, or `-g2005-sv`; they are outside a
Verilog-2005-only engine, leaving 1,758 initial compatibility cases.

The harness records the source revision and parses each case into a normalized
manifest containing test type, files, options, expected output, and required
capabilities. It supports normal execution, compile-only, expected compile
error, and expected runtime error cases. Skips require a named unsupported
capability and remain visible in coverage reports.

Native and WASM Icarus runs are high-value differential oracles, but are not
the language specification. The harness treats the IEEE standard and each
portable test's declared result as authoritative and records intentional
differences for documented Icarus extensions or deviations.

Icarus tests remain in their GPL-licensed repository. VeriFlow CI checks out a
pinned revision or reads an explicitly configured external checkout; the MIT
packages do not copy the test sources into published artifacts.

## Performance Gates

Correctness and performance use separate suites. The compatibility corpus is
not a benchmark because many cases are intentionally tiny and dominated by
startup or output.

The performance suite includes counters, combinational arithmetic, UART, FIFO,
parameterized generate designs, inferred memories, wide-vector arithmetic,
multi-driver nets, UDPs, specify timing, and VCD-heavy runs. It records compile
time, simulation wall time, scheduled and executed events, peak memory, trace
bytes, and artifact time for native Icarus, Icarus WASM, and TypeScript.

Before the TypeScript backend can replace `builtin`:

- it passes at least 95 percent of the 1,758-case Verilog-2005 corpus;
- every skipped case has an explicit capability classification;
- no release-blocking correctness divergence remains in ordinary RTL;
- median simulation time without VCD is no more than 2x native `vvp`;
- no ordinary RTL benchmark is more than 5x native `vvp` without an accepted
  documented reason;
- VCD-enabled performance and peak memory remain within release budgets; and
- the full CLI, VS Code, packaging, cancellation, and artifact suites pass.

Reaching these thresholds does not automatically change the default. It makes
the backend eligible for a separate product decision and compatibility review.

## Delivery Phases

### Phase 1: Productize Icarus WASM

- Add the backend registry and Icarus WASM adapter.
- Move VS Code simulation to the shared asynchronous contract.
- Preserve native and custom command backends.
- Add cancellation, timeout, VCD artifact, package, and license gates.

### Phase 2: Build The Regression Bridge

- Pin the Icarus source and test revision.
- Parse the Verilog-2005 test list into a machine-readable manifest.
- Run native/WASM parity and establish stable result normalization.
- Add the independent performance corpus and benchmark reporting.

### Phase 3: Build The TypeScript Core

- Implement preprocessing, semantic AST, constant evaluation, and elaboration.
- Add four-state values, expressions, lvalues, hierarchy, and common processes.
- Add the event scheduler, NBA semantics, delays, tasks, VCD, and system tasks.
- Expose `experimental-ts` only after core correctness and resource tests pass.

### Phase 4: Complete Verilog-2005 Compatibility

- Add UDPs, strengths, transistor networks, force/release, specify, timing
  checks, and SDF.
- Close portable regression gaps by capability group.
- Optimize measured hot paths without weakening four-state semantics.

### Phase 5: Evaluate The Default

- Run the 95-percent compatibility and performance gates.
- Review remaining deviations and real-project results.
- Record a separate decision before changing `builtin` away from Icarus WASM.

## Licensing Boundary

`@veriflow/iverilog-wasm` distributes Icarus binaries and is
GPL-2.0-or-later. Any VeriFlow distribution containing it must ship the
required notices, exact source provenance, complete corresponding source or
equivalent compliant access, and reproducible build instructions. Legal and
release review remains a gate before publication.

The TypeScript simulator is a clean implementation based on IEEE 1364-2005,
project-authored models, and observable regression behavior. It does not copy
or translate Icarus implementation code. Test-only use of the Icarus corpus
retains its original licensing and repository boundary.

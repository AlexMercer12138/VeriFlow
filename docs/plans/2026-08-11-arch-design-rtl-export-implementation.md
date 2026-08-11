# Arch Design RTL Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic, host-neutral Verilog-2001 and conservative SystemVerilog generation for validated schema-v1 Arch Designs.

**Architecture:** Add one `rtl.ts` implementation inside the existing `@veriflow/schematic-core/arch-design` public subpath. The exporter resolves and validates its own owned snapshot, projects resolved endpoints into collision-safe internal nets and explicit instance bindings, and returns immutable generated text or immutable diagnostics. Filesystem writes and overwrite policy remain outside the core for the following CLI/VS Code phase.

**Tech Stack:** TypeScript, Node test runner, `@veriflow/schematic-core`, shared HDL width models, optional Icarus Verilog syntax checks.

---

### Task 1: Public Result And Generated Marker

**Files:**
- Create: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Create: `packages/schematic-core/test/archDesignRtl.test.ts`

**Step 1: Write the failing public API tests**

Add tests that import `exportArchDesignRtl` and `parseArchDesignRtlMarker` from
`../src/archDesign`. Assert that an empty design exports exactly one stable
module, defaults to Verilog and `.v`, includes a source/schema/fingerprint
marker, and that the parser recovers the marker. Assert that a source path with
CR/LF is represented only as an escaped JSON string.

```ts
const result = exportArchDesignRtl(createEmptyArchDesign('soc_top'), [], {
    sourcePath: 'designs/soc_top.ad',
});
assert.equal(result.status, 'generated');
if (result.status !== 'generated') return;
assert.equal(result.language, 'verilog');
assert.equal(result.extension, '.v');
assert.deepEqual(parseArchDesignRtlMarker(result.text), {
    schemaVersion: 1,
    fingerprint: result.fingerprint,
    language: 'verilog',
});
```

**Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core && npx tsc -p packages/schematic-core/tsconfig.test.json && node --test packages/schematic-core/dist-test/test/archDesignRtl.test.js
```

Expected: compilation fails because the RTL export API is absent.

**Step 3: Implement the minimal marker and empty-module exporter**

Define frozen discriminated results and options:

```ts
export type ArchDesignRtlExportResult =
    | Readonly<{
        status: 'generated';
        language: ArchDesignLanguage;
        extension: '.v' | '.sv';
        fingerprint: string;
        marker: string;
        text: string;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly ArchDesignDiagnostic[];
    }>;
```

Resolve the effective language, compute the fingerprint with that language,
render the machine marker and JSON-escaped source comment, and emit
`module <name>;` / `endmodule`. Export the new file from `index.ts`.

**Step 4: Run the focused test and verify GREEN**

Run the focused command from Step 2. Expected: all RTL tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/src/archDesign/index.ts packages/schematic-core/test/archDesignRtl.test.ts
git commit -m "feat(schematic-core): add Arch Design RTL export API"
```

### Task 2: Ports, Internal Nets, And Boundary Assignments

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`

**Step 1: Write failing ordered port and connection tests**

Add a parsed design with scalar and vector input/output ports, connections that
share names with top ports, and fanout. Assert declaration order, exact packed
ranges, collision-safe internal net names, one assignment from each input port,
and one assignment into each output port. Add an effective language override
test and assert SystemVerilog uses `.sv` and a distinct fingerprint.

**Step 2: Run the focused test and verify RED**

Expected: the empty-module implementation lacks port lists, nets, and assigns.

**Step 3: Implement deterministic boundary projection**

Use `resolveArchDesign()` as the only semantic source. Reject immediately when
resolution diagnostics are non-empty. Allocate each connection a stable
`__vf_net_<name>` identifier while reserving declared top ports and instance
names. Select a renderable connection width from a definite source first, then
declaration order. Render ANSI Verilog-2001 `input wire`, `output wire`, and
`inout wire` declarations. Bind resolved endpoint identities to connection net
names and emit top input/output continuous assignments in declaration order.

**Step 4: Run the focused test and verify GREEN**

Run the focused command. Expected: all RTL tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/test/archDesignRtl.test.ts
git commit -m "feat(schematic-core): export Arch Design ports and networks"
```

### Task 3: Explicit Instances, Parameters, And Defaults

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`

**Step 1: Write failing instance/default golden tests**

Add definitions with ordered parameters and ports. Assert explicit named
parameter mappings in definition order, raw string/numeric/boolean rendering,
explicit named port mappings, empty mappings for unused outputs/inouts, direct
defaults for completely unconnected receivers, and one net assignment for a
driverless connected fanout. Assert connection defaults win over design
defaults through the existing resolver semantics.

**Step 2: Run the focused test and verify RED**

Expected: instance text and effective defaults are absent.

**Step 3: Implement instance and default binding**

Build maps from resolved target identity to connected net and effective
default. Build the driverless-connection default map from
`connectionDefaultSources`. Render each resolved instance only when it has a
unique definition; diagnostics already block every other case. For each
definition port, choose connected net, unconnected load default, or an empty
mapping. Emit driverless net assignments once before instance declarations.

**Step 4: Run the focused test and verify GREEN**

Run the focused command. Expected: all RTL tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/test/archDesignRtl.test.ts
git commit -m "feat(schematic-core): export Arch Design instances and defaults"
```

### Task 4: Scalar And Per-Bit Top-Level Inout

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`

**Step 1: Write failing inout golden tests**

Add width-one, width-eight scalar-control, and width-eight full-control designs.
Assert `_i` emits `assign <net> = <port>`, scalar `_t` emits one tri-state
continuous assignment with replicated `z`, unconnected `_t` uses implicit
`1'b1`, and full-width `_t` emits a Verilog-2001 `genvar` plus named generate
loop. Include a collision with the preferred generated identifiers.

**Step 2: Run the focused test and verify RED**

Expected: inout drive/readback assignments and generate loops are absent.

**Step 3: Implement inout projection**

Resolve `i`, `o`, and `t` targets for each inout port. Determine scalar control
from a width-one connected peer or an unconnected default; determine per-bit
control from a connected peer matching the full port width. Width-one ports
always use scalar control. Allocate collision-safe genvar and block names and
render traditional `generate` syntax without SystemVerilog-only constructs.

**Step 4: Run the focused test and verify GREEN**

Run the focused command. Expected: all RTL tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/test/archDesignRtl.test.ts
git commit -m "feat(schematic-core): export top-level inout logic"
```

### Task 5: Failure Gate, Determinism, And Snapshot Hardening

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`
- Modify: `packages/flow-core/test/boundaries.test.ts`

**Step 1: Write failing hardening tests**

Add tests that invalid semantics return `status: "invalid"` with no generated
text, including `interfaceConnections`. Assert two exports are byte-identical,
presentation/output-path changes do not alter text or fingerprint, effective
language changes do, result arrays/objects are frozen, and caller mutations
after export cannot affect the result. Extend the host-consumer boundary test
to compile the public RTL API from `@veriflow/schematic-core/arch-design`.

**Step 2: Run focused tests and verify RED**

Run the schematic-core focused test and the flow-core boundary test. Expected:
at least one new hardening or public-boundary assertion fails before the final
implementation changes.

**Step 3: Implement minimal hardening**

Clone public diagnostics, freeze every public result and marker object, ensure
all iteration uses resolver-owned arrays/maps, and keep source-path handling
comment-only and JSON escaped. Do not import Node filesystem/path APIs, DOM,
Electron, VS Code, X6, or any product package.

**Step 4: Verify focused and package tests**

Run:

```bash
npm test --workspace @veriflow/schematic-core
npm test --workspace @veriflow/flow-core
npm run verify:generated
npm pack --dry-run --workspace @veriflow/schematic-core --json
```

Expected: all tests pass and packed `dist/archDesign/rtl` files are present.

**Step 5: Optionally compile generated fixtures with Icarus**

When `iverilog` is available, write test-owned temporary fixture text and run
`iverilog -g2001` for Verilog plus `iverilog -g2012` for SystemVerilog. The test
must skip cleanly when the executable is unavailable and must not add Python.

**Step 6: Commit**

```bash
git add packages/schematic-core/src/archDesign/rtl.ts packages/schematic-core/test/archDesignRtl.test.ts packages/flow-core/test/boundaries.test.ts
git commit -m "test: harden Arch Design RTL export boundaries"
```

### Task 6: Full Regression And Final Review

**Files:**
- Review: `packages/schematic-core/src/archDesign/rtl.ts`
- Review: `packages/schematic-core/test/archDesignRtl.test.ts`
- Review: `packages/flow-core/test/boundaries.test.ts`

**Step 1: Run the complete repository suite**

```bash
xvfb-run -a npm test
npm run verify:generated
git diff --check main..HEAD
```

Expected: CLI, shared packages, Electron, VS Code tests, generated assets, and
VSIX packaging all pass with no whitespace errors.

**Step 2: Review scope and public API**

Inspect `git diff --stat main..HEAD`, `git diff main..HEAD`, package contents,
and public declarations. Confirm there are no filesystem writes, host imports,
Python files/tests, CLI commands, VS Code editor changes, or interface protocol
implementation in this phase.

**Step 3: Commit review-only fixes through RED/GREEN cycles**

For every defect found, first add a failing regression test, verify RED, apply
the smallest fix, verify GREEN, and commit with a specific message.

**Step 4: Finish the feature branch**

Use `superpowers:verification-before-completion`, then
`superpowers:finishing-a-development-branch` to present integration options.

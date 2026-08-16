# Icarus WASM Virtual Run CWD Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve existing VeriFlow `simulation_files` paths outside `project_root` by adding a safe virtual VVP working directory to `@veriflow/iverilog-wasm` and consuming it from the adapter.

**Architecture:** Add an optional normalized relative POSIX `runCwd` to upstream run and simulate requests, defaulting to `.` for compatibility. The runtime continues staging files and collecting artifacts relative to `/work`, but runs VVP from `/work/<runCwd>`. The VeriFlow adapter maps all requested host files beneath one deterministic virtual root, passes the project-root location as `runCwd`, and keeps compiler sources, include paths, runtime paths, diagnostics, and artifact paths coherent.

**Tech Stack:** TypeScript 5.9, Node worker threads, Emscripten FS, Node test runner, npm packaging.

---

### Task 1: Add the upstream virtual run directory

**Files:**
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/src/types.ts`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/src/validate.ts`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/src/runtime.ts`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/test/validate.test.mjs`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/test/run.test.mjs`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/test/simulate.test.mjs`

**Step 1:** Add failing validation tests for the default `.` value, a normalized nested directory, and rejection of absolute paths, `..`, empty components, backslashes, NUL, and `.iverilog`.

**Step 2:** Add real failing run/simulate tests in which VVP runs from `project/rtl`, reads `../vectors/input.hex`, and returns an artifact rooted at `/work`.

**Step 3:** Add `runCwd?: string` to public requests and a required normalized value to internal requests. Validate it as `.` or a safe relative POSIX directory.

**Step 4:** Let only the VVP stage change to `/work/<runCwd>` after staging. Keep compilation at `/work` and artifact collection rooted at `/work`.

**Step 5:** Run the focused tests and the complete upstream WASM suite, then commit.

### Task 2: Package and publish 0.1.2

**Files:**
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/package.json`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/package-lock.json`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/test/package.test.mjs`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/.github/workflows/test.yml`
- Modify: `/home/mercer/prj/iverilog/.worktrees/veriflow-wasm-runtime/wasm/package/README.md`

**Step 1:** Change immutable package and workflow references from `0.1.1` to `0.1.2`, and document `runCwd`.

**Step 2:** Build and package from a clean upstream tree, run package tests and clean-install smoke, and inspect tarball provenance.

**Step 3:** Commit release metadata, publish the tarball, and verify registry version, integrity, and Node engine metadata.

### Task 3: Consume runCwd in VeriFlow

**Files:**
- Modify: `packages/simulator-iverilog-wasm/src/iverilogApi.ts`
- Modify: `packages/simulator-iverilog-wasm/src/virtualWorkspace.ts`
- Modify: `packages/simulator-iverilog-wasm/src/iverilogWasmBackend.ts`
- Modify: `packages/simulator-iverilog-wasm/test/virtualWorkspace.test.ts`
- Modify: `packages/simulator-iverilog-wasm/test/iverilogWasmBackend.test.ts`
- Modify: `packages/cli/test/builtinSimulation.test.ts`
- Modify: `packages/simulator-iverilog-wasm/package.json`
- Modify: `package-lock.json`

**Step 1:** Add failing workspace/adapter tests and a real CLI smoke for `project_root: rtl`, `simulation_files: vectors/input.hex`, and `$readmemh("../vectors/input.hex")`.

**Step 2:** Map the project cwd and every requested file beneath one deterministic safe virtual root, preserve host-relative relationships, and expose a virtual `runCwd`.

**Step 3:** Forward `runCwd`, keep compiler sources and include roots valid, and retain artifact and diagnostic mapping contracts.

**Step 4:** Pin `@veriflow/iverilog-wasm` to `0.1.2`, refresh the lockfile, and run adapter, CLI, flow-core, typecheck, and package-boundary verification.

**Step 5:** Commit and rerun Task 9 specification and quality reviews.

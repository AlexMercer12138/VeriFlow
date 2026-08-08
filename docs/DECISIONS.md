# Project Decision Log

> This file preserves architectural decisions and rationale for AI coding assistants.
> Read this file at the start of sessions to understand project history.

---

## 2026-08-08: Retire Python products in favor of Node CLI and VS Code

**Context:** VeriFlow currently duplicates HDL, simulation, waveform, and project-flow behavior across a Python GUI/CLI and a TypeScript VS Code extension. The TypeScript implementation is already the stronger HDL implementation, and maintaining two product runtimes is no longer desirable.

**Decision:** Extract host-neutral TypeScript packages shared by a fully Python-CLI-compatible Node CLI and the VS Code extension. Ship an Electron host for the shared waveform frontend, keep native simulation behind an extensible backend interface, and retire the Python GUI/CLI only after compatibility and release gates pass.

**Why not:**
- Keep the Python GUI and use a Node sidecar: this retains two product runtimes and the wheel/PyInstaller bridge that the new product direction is intended to remove.
- Let the CLI import `veriflow-vscode/src/core` directly: this makes VS Code an accidental owner of shared domain code and prevents clean product boundaries.
- Break compatibility with the Python CLI: existing project JSON files and automation must continue to work without conversion.
- Open the waveform as a static browser file: indexed VCD window, value, and search requests require a Node host; Electron can reuse the existing memory transport and worker lifecycle directly.

**Affects:** `packages/`, `veriflow-vscode/`, `src/`, `pyproject.toml`, `package.json`, `.github/workflows/ci.yml`

**Tags:** #architecture #tooling #migration

---

## 2026-08-08: Run release npm commands through Node

**Context:** The cross-platform clean-install gate exposed that Windows `.cmd` shims cannot be passed directly to `execFileSync` or to `spawnSync` without a shell. The release scripts must run identically on Linux, macOS, and Windows without shell-specific quoting.

**Decision:** Release scripts invoke npm as `process.execPath` plus the `npm_execpath` supplied by the outer npm lifecycle. Clean-installed CLI commands run through `npm exec -- veriflow`, which resolves the local package bin on each platform.

**Why not:**
- Execute `npm.cmd` or `veriflow.cmd` directly: Windows command shims are not native executables and fail with the no-shell child-process APIs used by the scripts.
- Enable `shell: true`: shell parsing creates platform-specific quoting rules and an unnecessary command-injection boundary.
- Invoke the CLI's compiled JavaScript directly: that would stop the release smoke from testing the published `bin` contract.

**Affects:** `scripts/lib/npm-command.mjs`, `scripts/pack-node-release.mjs`, `scripts/test-node-release.mjs`, `.github/workflows/ci.yml`

**Tags:** #lesson-learned #tooling #infrastructure

---

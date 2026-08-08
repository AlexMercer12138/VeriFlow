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

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

## 2026-08-09: Complete the Python product retirement

**Context:** The v1.4.0 compatibility release published the Node CLI, shared TypeScript packages, VS Code extension, and one final set of deprecated Python artifacts. The Node CLI contract and cross-platform release gates passed, so the temporary rollback window is complete.

**Decision:** Remove the Python GUI/CLI, Python packages and tests, worker-wheel and PyInstaller paths, and deprecated release artifacts. Maintain only the Node CLI and VS Code extension, with the 85-case Node CLI contract as the compatibility boundary for existing projects and automation.

**Affects:** `packages/`, `scripts/`, `.github/workflows/`, `README.md`

**Tags:** #architecture #tooling #migration #retirement

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

## 2026-08-09: Add a personal brand without changing VeriFlow identities

**Context:** The VeriFlow name alone is difficult to distinguish, while a complete rename would create unnecessary migration work and could disrupt existing users. The VS Code display name, "Verilog Simulation Flow," is also too narrow now that the product covers analysis, visual design, testbench generation, simulation, and waveform viewing.

**Decision:** Use `Vik-VeriFlow` as the repository and project brand, keep the `veriflow` CLI command and existing compatibility identifiers, and change only the VS Code Marketplace display name to "Verilog Design Flow." Preserve the Marketplace identity `Vikai-mercer.veriflow`, `veriflow.*` command and configuration keys, and `.veriflow_config.json` compatibility.

**Why not:**
- Adopt an entirely new abstract product name: it would require broad package, command, documentation, and release migration before the first Node release.
- Rename the VS Code extension ID: changing its publisher or package `name` would create a separate Marketplace extension and break automatic updates for current users.
- Keep "Verilog Simulation Flow": simulation no longer represents the visual design and broader project workflow.
- Use "Verilog Design & Verification Flow": it is accurate but unnecessarily long for Marketplace and VS Code UI surfaces.

**Affects:** `README.md`, `veriflow-vscode/package.json`, `veriflow-vscode/README.md`, GitHub repository metadata

**Tags:** #architecture #tooling #migration #branding

---

## 2026-08-09: Share a TypeScript schematic core and author Arch Designs

**Context:** The current Dagre/X6 schematic splits networks into independent
edges, fixes bidirectional pins to the bottom, and cannot guarantee compact
column layout, obstacle-free orthogonal routes, or correct junctions. Visual
composition also needs a source format that can generate explicit interface
defaults without rewriting arbitrary hand-written HDL.

**Decision:** Build a host-neutral TypeScript schematic core for column
placement, channel routing, interface recognition, and rendering geometry.
Keep `.v/.sv` schematics as inspection views, and use versioned `.ad` Arch
Design files as the source of truth for visual module composition and
deterministic RTL generation, defaulting to sibling Verilog-2001 `.v` output.

**Why not:**
- Port the Vik-SchGen router directly: its BFS placement, pairwise MST routes, whole-column bypasses, and post-route shrink do not match directed HDL flow or the required geometry guarantees.
- Continue patching Dagre and X6 edges: presentation-layer routing cannot reliably model shared network trees, track occupancy, or direction-based junctions.
- Edit existing HDL directly: safe source rewriting across macros, includes, and arbitrary coding styles is outside the focused design-to-export workflow.
- Use Vivado `.bd`: VeriFlow does not implement that format and should not imply compatibility.
- Show implicit defaults only on the canvas: generated HDL must explicitly implement every default shown by the editor.

**Affects:** `packages/schematic-core/`, `packages/schematic-webview/`,
`packages/cli/`, `veriflow-vscode/src/schematic/`,
`docs/plans/2026-08-09-schematic-arch-design-design.md`

**Tags:** #architecture #tooling #schematic #routing #code-generation

---

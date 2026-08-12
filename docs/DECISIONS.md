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

## 2026-08-11: Share a right-side Inspector and keep network names off-canvas

**Context:** The phase-one schematic renderer exposes top-level port names
poorly, draws offset network-label backgrounds, applies X6 bounding boxes to
selected wire trees, and has insufficient contrast in dark themes. The `.ad`
editor also needs one extensible property surface for networks, instances,
ports, parameters, defaults, and export settings.

**Decision:** Reuse one webview-owned, collapsible right-side Inspector for
read-only HDL schematics and editable Arch Designs. Keep network names in the
semantic graph and show them in the Inspector, but draw no network labels on
the canvas. Select networks through logical network IDs and highlight only
their segments and junctions; reserve X6 selection boxes for nodes. Strengthen
shared theme tokens for modules, ports, pins, and wires.

**Why not:**
- Bottom property drawer: complex endpoint, interface-default, and parameter
  data becomes cramped and consumes vertical canvas space.
- VS Code native side View: selection ownership becomes ambiguous with multiple
  open schematic editors and requires more cross-panel synchronization.
- Keep canvas network labels: their backgrounds obscure routing and duplicate
  information that selection and the Inspector can present without clutter.
- Use X6 edge selection boxes: a wire-tree bounding rectangle looks like a
  selected area and misrepresents the selected electrical object.

**Affects:** `packages/schematic-core/`, `packages/schematic-webview/`,
`veriflow-vscode/src/schematic/`,
`docs/plans/2026-08-11-ad-editor-schematic-ux-design.md`

**Tags:** #architecture #schematic #frontend #arch-design

---

## 2026-08-11: Add Arch Design CLI export through a thin host adapter

**Context:** The host-neutral Arch Design parser, semantic resolver, and RTL
exporter are complete, but users cannot yet validate or safely publish generated
RTL from the maintained Node CLI.

**Decision:** Add explicit `veriflow ad validate` and `veriflow ad export`
commands as a thin Node adapter over the shared core and HDL workspace index.
Use the design directory as the standalone module root, allow an optional
project catalog, require output extensions to match the effective language,
and atomically replace only files with a valid VeriFlow generation marker.

**Why not:**
- Add build and simulation auto-export now: it expands the regression surface
  before the explicit file workflow is proven.
- Build a generic injected filesystem service: VS Code URI requirements are not
  implemented yet, so the abstraction would be speculative.
- Permit `--force`: hand-written RTL must remain protected even when a caller
  supplies the wrong output path.
- Require a project for every command: standalone `.ad` validation and export
  should work with modules beside the design.

**Affects:** `packages/cli/`, `packages/schematic-core/src/archDesign/`, `README.md`,
`docs/plans/2026-08-11-arch-design-cli-export-design.md`

**Tags:** #architecture #cli #arch-design #code-generation #filesystem

---

## 2026-08-12: Host writable Arch Designs separately while sharing the schematic webview

**Context:** `.v` and `.sv` schematics are read-only inspection views whose
provider owns HDL parsing, source navigation, include watching, and separate
layout persistence. A writable `.ad` design needs native VS Code undo/save,
schema-aware edits, semantic diagnostics, and failure-safe RTL publication,
while retaining the same visual layout and routing behavior.

**Decision:** Register a separate `veriflow.archDesignEditor` custom text
editor for `.ad` documents and reuse the existing schematic webview. Keep all
deterministic edits, validation, graph projection, and RTL generation in
`@veriflow/schematic-core/arch-design`. The provider accepts revision-bound
commands, applies full-document `WorkspaceEdit` operations, persists layout in
the `.ad` document, and atomically replaces only RTL carrying a valid VeriFlow
generation marker. This phase supports scalar authoring only; interface
recognition, collapsed AXI/APB/AHB buses, and project-defined protocols remain
a separate follow-up.

**Why not:**
- Make the HDL provider writable: source rewriting across macros, includes,
  and arbitrary coding styles would couple unrelated document lifecycles.
- Create a second frontend: duplicate rendering and interaction code would let
  HDL inspection and Arch Design editing drift visually.
- Add interface recognition to schema-v1 scalar editing: it would expand the
  protocol and validation surface before the basic design-to-export workflow
  is stable.
- Allow forced RTL overwrite: an incorrect output path must never destroy
  hand-written source.

**Affects:** `packages/schematic-core/`, `packages/schematic-webview/`,
`veriflow-vscode/src/archDesign/`, `veriflow-vscode/src/schematic/`

**Tags:** #architecture #vscode #schematic #arch-design #code-generation

---

## 2026-08-12: Acknowledge Arch Design presentation writes without rebuilding the graph

**Context:** Arch Design selection, viewport changes, and node movement shared a
full-document edit path. The provider treated its own presentation write as a
new semantic document, republished `initialize` and `graph`, and cleared the
selection after every ordinary interaction.

**Decision:** Keep selection in webview state only. Continue persisting viewport
and node placement in `.ad`, but recognize provider-owned presentation-only
document changes and respond with a lightweight revision acknowledgement.
Rebuild the graph only for semantic edits, external document changes, undo/redo,
or catalog changes. Relayout locally and persist it through the same lightweight
presentation path. Serialize presentation and semantic writes, coalesce newer
layouts in both the webview and provider, and fit a design with no saved viewport
once per webview without dirtying the document.

**Why not:**
- Stop persisting presentation: users would lose deliberate placement and viewport state.
- Store presentation in a sidecar: `.ad` would cease to be the complete portable design source.
- Ignore all presentation document changes: the provider snapshot would retain an old revision and could overwrite the latest layout during a later semantic edit.

**Affects:** `packages/schematic-webview/`,
`veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`,
`veriflow-vscode/src/schematic/protocol.ts`

**Tags:** #architecture #lesson-learned #vscode #schematic #arch-design

---

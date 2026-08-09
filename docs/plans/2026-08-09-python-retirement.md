# Python Retirement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Python GUI/CLI and every active Python build path while preserving the Node CLI contract and leaving Node CLI plus VS Code as the only maintained products.

**Architecture:** Treat the existing Node CLI contract as the compatibility boundary, then enforce the Node-only repository state with a source-policy test. Replace the Python release helper with a small tested Node module and CLI wrapper; CI, releases, package scripts, and current documentation will reference only TypeScript/Node products.

**Tech Stack:** Node.js 24, TypeScript 5.9, Node test runner, npm workspaces, GitHub Actions, Electron, VS Code extension tooling.

---

### Task 1: Add the Node-only source policy gate

**Files:**
- Create: `scripts/lib/python-retirement.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing policy test**

Create a Node test that walks tracked source locations and asserts:

- no file ends in `.py` or `.spec`;
- `pyproject.toml`, `requirements.txt`, `run_cli.py`, `run_gui.py`, and `python-packages/` do not exist;
- active package manifests and `.github/workflows/*.yml` contain no `python`, `pytest`, `pyinstaller`, Python compatibility artifacts, or worker-wheel commands;
- the Node release entry point is `scripts/run-release.mjs` and the old Python entry point is absent.

Historical files below `docs/plans/` and `docs/releases/` are records and are not scanned for textual references.

**Step 2: Register the policy test**

Extend `test:release` in `package.json`:

```json
"test:release": "node --test scripts/lib/npm-command.test.mjs scripts/lib/python-retirement.test.mjs scripts/lib/release.test.mjs && node scripts/test-node-release.mjs"
```

The release test file will be added in Task 3; run the policy test directly for this red step.

**Step 3: Run the test and verify RED**

Run: `node --test scripts/lib/python-retirement.test.mjs`

Expected: FAIL listing current Python files and active workflow/package references.

**Step 4: Commit the gate**

```bash
git add package.json scripts/lib/python-retirement.test.mjs
git commit -m "test: enforce Node-only repository policy"
```

### Task 2: Remove Python products, packages, tests, and tools

**Files:**
- Delete: `src/`
- Delete: all `tests/*.py` and `tests/cli_contract/*.py`
- Preserve: `tests/cli_contract/cases.json` and all language-neutral fixtures consumed by Node tests
- Delete: `run_cli.py`
- Delete: `run_gui.py`
- Delete: `pyproject.toml`
- Delete: `requirements.txt`
- Delete: `VeriFlow.spec`
- Delete: `VeriFlow-cli.spec`
- Delete: `ParserProbe.spec`
- Delete: `python-packages/`
- Delete: `scripts/benchmark_hdl_baseline.py`
- Delete: `scripts/benchmark_waveform_index.py`
- Delete: `scripts/build_parser_probe_wheel.py`
- Delete: `scripts/capture_cli_contract.py`
- Delete: `scripts/generate_waveform_benchmark.py`
- Delete: `scripts/parser_probe_entry.py`
- Delete: `scripts/run_release.py`
- Delete: `scripts/worker_wheel_provenance.py`
- Modify: `.gitignore`
- Modify: `veriflow-vscode/package.json`

**Step 1: Delete the authorized Python inventory**

Delete only the files and directories listed above. Do not delete JSON, Verilog/SystemVerilog, VCD, WASM, or TypeScript test fixtures.

**Step 2: Remove obsolete active references**

Remove the two Python waveform benchmark scripts from `veriflow-vscode/package.json`. Remove Python cache/package patterns and the worker-wheel path from `.gitignore`, while retaining language-neutral build, coverage, editor, and simulation-output ignores.

**Step 3: Run the policy test again**

Run: `node --test scripts/lib/python-retirement.test.mjs`

Expected: FAIL only on CI/release workflow and missing Node release-runner requirements that are addressed in later tasks. No Python source-file failure remains.

**Step 4: Re-run the compatibility boundary**

Run: `npm test --workspace @veriflow/cli`

Expected: `85` tests, `85` pass, `0` fail.

**Step 5: Commit product removal**

```bash
git add -A
git commit -m "refactor: remove retired Python products"
```

### Task 3: Replace the release helper with Node

**Files:**
- Create: `scripts/lib/release.mjs`
- Create: `scripts/lib/release.test.mjs`
- Create: `scripts/run-release.mjs`
- Modify: `package.json`

**Step 1: Write failing release-helper tests**

Use temporary package fixtures to cover:

- strict `MAJOR.MINOR.PATCH` parsing and patch increments;
- version consistency across root, `packages/*`, and `veriflow-vscode/package.json`;
- VS Code changelog heading validation;
- updating all workspace versions and internal `@veriflow/*` dependency pins;
- updating the `version` and `version_short` CLI contract outputs;
- rejecting malformed versions, mismatched current versions, and malformed contract cases;
- parsing `--check`, `--update [VERSION]`, `--package`, and `--all [VERSION]` plus short aliases.

**Step 2: Run the release tests and verify RED**

Run: `node --test scripts/lib/release.test.mjs`

Expected: FAIL because `scripts/lib/release.mjs` does not exist.

**Step 3: Implement the release library**

Implement synchronous, explicit filesystem helpers in `scripts/lib/release.mjs`. Keep command execution injectable so unit tests use temporary directories without running npm or git. Version updates must write two-space JSON plus a trailing newline.

**Step 4: Implement the Node release entry point**

`scripts/run-release.mjs` must preserve the old public actions:

```text
-c, --check
-u, --update [VERSION]
-p, --package
-a, --all [VERSION]
```

`--check` runs only Node gates: version/changelog validation, shared typecheck/tests, Node CLI tests, waveform desktop tests, VS Code tests, release smoke, generated-file verification, `git diff --check`, and `git status --short --branch`.

`--package` runs `npm run pack:node` and the VS Code workspace package command. `--update` updates manifests and CLI contract data, then runs `npm install --package-lock-only --ignore-scripts`.

**Step 5: Register the release command**

Add:

```json
"release": "node scripts/run-release.mjs"
```

and include `scripts/lib/release.test.mjs` in `test:release`.

**Step 6: Run tests and verify GREEN**

Run: `node --test scripts/lib/release.test.mjs scripts/lib/npm-command.test.mjs`

Expected: all tests pass.

Run: `node scripts/run-release.mjs --help`

Expected: exit `0` with all four actions documented.

**Step 7: Commit the release runner**

```bash
git add package.json scripts/lib/release.mjs scripts/lib/release.test.mjs scripts/run-release.mjs
git commit -m "build: replace Python release helper with Node"
```

### Task 4: Remove Python from CI and tag releases

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Step 1: Remove Python jobs from CI**

Delete the Ubuntu `python` job and the Windows `python-deprecation-artifacts` job. In `hdl-runtime-feasibility`, retain Node setup, npm install/build, and Windows parser SEA smoke, but remove setup-python, wheel build/install/provenance, pytest, and PyInstaller collection steps.

**Step 2: Remove Python artifacts from releases**

Delete the release workflow's `python-deprecation-artifacts` job. Change `github-release.needs` to `node-artifacts`; keep the six npm tarballs, VSIX, and generated `SHA256SUMS.txt` as the release surface.

**Step 3: Verify the policy test is GREEN**

Run: `node --test scripts/lib/python-retirement.test.mjs`

Expected: all tests pass.

**Step 4: Validate workflow syntax structurally**

Run a Node YAML parser already present in the dependency tree if available; otherwise inspect both complete workflows and rely on the GitHub Actions CI execution after push. Also run:

```bash
rg -n -i 'python|pytest|pyinstaller|worker.?wheel|VeriFlow-cli\.exe|VeriFlow\.exe' .github package.json veriflow-vscode/package.json
```

Expected: no matches.

**Step 5: Commit workflow cleanup**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: retire Python build and release paths"
```

### Task 5: Rewrite current documentation for the two-product model

**Files:**
- Modify: `README.md`
- Modify: `docs/DECISIONS.md`

**Step 1: Rewrite the root README in concise Chinese**

Keep only these sections:

- Vik-VeriFlow purpose and the Node CLI / VS Code product forms;
- features: project management, HDL analysis, simulation, testbench/schematic editing, and waveform viewing;
- requirements: Node.js/npm and a supported native simulator;
- global CLI install: `npm install -g @veriflow/cli`;
- CLI examples for `project`, `lib`, `top`, `analyze`, `sim`, and `wave`;
- VS Code extension installation and normal use;
- a compact `project.json` example;
- source-development commands and Node release commands;
- GitHub Releases and MIT license.

Do not describe internal architecture, migration history, Python setup, or deprecated artifacts.

**Step 2: Record the completed decision**

Append a dated status entry to `docs/DECISIONS.md` stating that the v1.4.0 compatibility release passed its retirement gate and active Python products/builds were removed, with the Node CLI contract retained as the compatibility boundary.

**Step 3: Check current documentation references**

Run:

```bash
rg -n -i 'python|pyinstaller|pytest|run_release\.py|VeriFlow-cli\.exe|VeriFlow\.exe' README.md package.json .github veriflow-vscode/package.json
```

Expected: no matches.

**Step 4: Commit documentation**

```bash
git add README.md docs/DECISIONS.md
git commit -m "docs: present Node CLI and VS Code products"
```

### Task 6: Run the Node-only retirement gate

**Files:**
- Verify: all changed files

**Step 1: Restore a clean dependency tree**

Run `npm ci` using the repository's npm script policy. If the local WSL install cannot fetch `@vscode/vsce-sign-linux-x64`, use `npm ci --ignore-scripts` followed by the explicit project build commands; record the skipped third-party postinstall limitation rather than weakening CI.

**Step 2: Verify no Python implementation or packaging remains**

Run:

```bash
find . -path './node_modules' -prune -o -path './.git' -prune -o \( -name '*.py' -o -name '*.spec' -o -name 'pyproject.toml' -o -name 'requirements*.txt' \) -print
npm run test:release
```

Expected: `find` prints nothing and the release gate passes.

**Step 3: Re-run the exact CLI compatibility suite**

Run: `npm test --workspace @veriflow/cli`

Expected: `85` tests, `85` pass, `0` fail, matching the pre-removal baseline.

**Step 4: Run shared and product checks**

Run:

```bash
npm run typecheck:shared
npm run test:shared
npm test --workspace @veriflow/waveform-desktop
npm test --workspace veriflow-vscode
npm run verify:generated
npm run package --workspace veriflow-vscode
```

Expected: all available checks exit `0`; if Electron cannot launch under WSL due missing system libraries, preserve the exact error and require the Linux CI job to validate that host-specific gate.

**Step 5: Inspect the final repository and diff**

Run:

```bash
git diff --check
git status --short --branch
git diff --stat main...HEAD
```

Confirm that language-neutral fixtures still exist, active automation is Node-only, and no unrelated user changes were removed.

**Step 6: Commit any final corrections**

```bash
git add -A
git commit -m "chore: complete Python retirement"
```

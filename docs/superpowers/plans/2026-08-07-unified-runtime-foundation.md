# Unified Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the root npm workspace, deterministic canonical Web artifacts, and a hard feasibility gate proving that the pinned Tree-sitter runtime can run from a Windows Node SEA executable distributed through a wheel and collected by PyInstaller.

**Architecture:** The repository root becomes the only npm install and lockfile boundary. Shared build helpers generate committed `web-dist/` assets and copy them into VS Code packaging, while Python loads the canonical assets directly. A deliberately small parser-worker probe exercises `web-tree-sitter`, both pinned WASM files, JSONL pipes, a Windows SEA executable, wheel resource lookup, hidden process startup, and PyInstaller collection before any HDL extraction begins.

**Tech Stack:** Node.js 24.14.1, npm workspaces, TypeScript 5, esbuild 0.28.1, Node SEA, postject, web-tree-sitter 0.26.11, tree-sitter-systemverilog 0.4.0, Python 3.11+, setuptools, build, PyInstaller, pytest.

---

## File Structure

Create or reshape these ownership boundaries before implementing behavior:

```text
package.json                         root commands and workspace membership
package-lock.json                    only npm dependency lockfile
.nvmrc                               pinned release-builder Node version
tsconfig.base.json                   shared strict TypeScript defaults
scripts/build-web.mjs                canonical web-dist builder
scripts/build-vscode.mjs             extension asset copy and extension bundle entry
scripts/verify-generated.mjs         clean rebuild and tracked-drift check
scripts/build-parser-probe.mjs       SEA probe bundle/blob/executable/manifest builder
scripts/lib/build-config.mjs         shared deterministic esbuild options
scripts/lib/files.mjs                stable copy/hash/JSON helpers
scripts/benchmark_hdl_baseline.py    pre-migration parser timing recorder
packages/waveform-webview/           current waveform source ownership
packages/schematic-webview/          current schematic source ownership
packages/parser-worker/              minimal SEA feasibility probe
python-packages/veriflow-hdl-worker/ minimal wheel used only by the feasibility gate
web-dist/                            committed canonical browser artifacts
tests/test_web_assets.py             Python canonical-asset contract
tests/test_parser_probe_package.py   installed-wheel and PyInstaller probe
```

The probe package is expanded into the production worker in the third plan. It must not expose production HDL service APIs in this plan.

### Task 1: Record the pre-migration baseline and guard current behavior

**Files:**
- Create: `scripts/benchmark_hdl_baseline.py`
- Create: `tests/benchmarks/hdl-fixtures.json`
- Create: `docs/performance/2026-08-07-hdl-regex-baseline.json`
- Create: `tests/test_migration_baseline.py`
- Modify: `tests/test_core_services.py`
- Test: `tests/test_migration_baseline.py`

- [ ] **Step 1: Write the failing fixture-manifest test**

```python
def test_hdl_benchmark_manifest_resolves_all_inputs() -> None:
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    manifest = json.loads(
        (root / "tests/benchmarks/hdl-fixtures.json").read_text(encoding="utf-8")
    )
    assert manifest["schemaVersion"] == 1
    assert manifest["topModule"] == "uart_tb"
    assert all((root / item).is_file() for item in manifest["files"])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_migration_baseline.py -v`

Expected: FAIL because `tests/benchmarks/hdl-fixtures.json` does not exist.

- [ ] **Step 3: Add the fixed fixture set**

```json
{
  "schemaVersion": 1,
  "topModule": "uart_tb",
  "files": [
    "tests/project_test/uart_rx.v",
    "tests/project_test/uart_tx.v",
    "tests/project_test/uart_tb.v",
    "veriflow-vscode/src/test/fixtures/hdl/structural.sv",
    "veriflow-vscode/src/test/fixtures/hdl/schematic-readonly.sv"
  ]
}
```

- [ ] **Step 4: Add a baseline recorder that times both current parsers without enforcing machine-specific absolute numbers**

```python
#!/usr/bin/env python
from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import time
from pathlib import Path

from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.port_parser_service import PortParserService
from src.infrastructure.file_service import FileService


ROOT = Path(__file__).resolve().parents[1]


def measure(repetitions: int) -> dict:
    fixture = json.loads(
        (ROOT / "tests/benchmarks/hdl-fixtures.json").read_text(encoding="utf-8")
    )
    parser = PortParserService(FileService())
    analyzer = DependencyAnalyzerService(FileService())
    parse_samples = []
    index_samples = []
    for _ in range(repetitions):
        started = time.perf_counter()
        for relative in fixture["files"]:
            parser.parse_file(str(ROOT / relative))
        parse_samples.append(time.perf_counter() - started)

        started = time.perf_counter()
        analyzer.resolve(fixture["topModule"], [ROOT / "tests/project_test"])
        index_samples.append(time.perf_counter() - started)
    return {
        "schemaVersion": 1,
        "repetitions": repetitions,
        "parseMedianSeconds": statistics.median(parse_samples),
        "indexMedianSeconds": statistics.median(index_samples),
        "fixtureManifest": "tests/benchmarks/hdl-fixtures.json",
        "environment": {
            "platform": platform.platform(),
            "python": sys.version,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=7)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = measure(args.repetitions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run the baseline tests and recorder**

Run: `python -m pytest tests/test_migration_baseline.py tests/test_core_services.py -v`

Expected: PASS.

Run: `python scripts/benchmark_hdl_baseline.py --repetitions 7 --output docs/performance/2026-08-07-hdl-regex-baseline.json`

Expected: exit 0 and JSON containing positive `parseMedianSeconds`,
`indexMedianSeconds`, and environment identity. Commit this pre-migration record;
later performance enforcement applies its 25% comparison only on a matching
environment and otherwise records a new paired benchmark report.

- [ ] **Step 6: Commit the baseline contract**

```bash
git add scripts/benchmark_hdl_baseline.py tests/benchmarks/hdl-fixtures.json docs/performance/2026-08-07-hdl-regex-baseline.json tests/test_migration_baseline.py tests/test_core_services.py
git commit -m "test: record HDL migration baseline"
```

### Task 2: Create the root npm workspace and one dependency lock

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `tsconfig.base.json`
- Create: `packages/parser-worker/package.json`
- Create: `packages/parser-worker/tsconfig.json`
- Create: `packages/waveform-webview/package.json`
- Create: `packages/waveform-webview/tsconfig.json`
- Create: `packages/schematic-webview/package.json`
- Create: `packages/schematic-webview/tsconfig.json`
- Modify: `veriflow-vscode/package.json`
- Delete: `veriflow-vscode/package-lock.json`
- Create: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Test: `veriflow-vscode/src/test/core.test.ts`

- [ ] **Step 1: Add a failing workspace-shape test**

Add this case to `veriflow-vscode/src/test/core.test.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '../../..');
const rootPackage = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'package.json'),
    'utf8'
)) as { private?: boolean; workspaces?: string[] };
assert.strictEqual(rootPackage.private, true);
assert.deepStrictEqual(rootPackage.workspaces, ['packages/*', 'veriflow-vscode']);
assert.ok(fs.existsSync(path.join(repositoryRoot, 'package-lock.json')));
assert.ok(!fs.existsSync(path.join(repositoryRoot, 'veriflow-vscode/package-lock.json')));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix veriflow-vscode`

Expected: FAIL because the root package and lockfile do not exist.

- [ ] **Step 3: Add the root package and shared TypeScript configuration**

```json
{
  "name": "veriflow-workspace",
  "private": true,
  "version": "1.3.2",
  "engines": {
    "node": "24.14.1"
  },
  "workspaces": [
    "packages/*",
    "veriflow-vscode"
  ],
  "scripts": {
    "build:web": "node scripts/build-web.mjs",
    "build:parser": "node scripts/build-parser-probe.mjs",
    "build:vscode": "node scripts/build-vscode.mjs",
    "build": "npm run build:web && npm run build:parser && npm run build:vscode",
    "test": "npm run test --workspaces --if-present",
    "verify:generated": "node scripts/verify-generated.mjs"
  },
  "devDependencies": {
    "@types/node": "24.10.1",
    "esbuild": "0.28.1",
    "postject": "1.0.0-alpha.6",
    "tree-sitter-systemverilog": "0.4.0",
    "typescript": "5.9.3",
    "web-tree-sitter": "0.26.11"
  }
}
```

Put `24.14.1` in `.nvmrc` and create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Add concrete package manifests**

Use this shape for `packages/parser-worker/package.json`:

```json
{
  "name": "@veriflow/parser-worker",
  "version": "1.3.2",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "npm run typecheck"
  },
  "dependencies": {
    "web-tree-sitter": "0.26.11"
  }
}
```

Both Webview package manifests use their actual names and only typecheck in this foundation:

```json
{
  "name": "@veriflow/waveform-webview",
  "version": "1.3.2",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

`@veriflow/schematic-webview` additionally keeps `@antv/x6`, `@dagrejs/dagre`, and `lucide` as package dependencies. Each package `tsconfig.json` extends `../../tsconfig.base.json`, sets `noEmit: true`, includes `src/**/*.ts`, and for Webviews includes `lib: ["ES2020", "DOM"]`.
The temporary waveform configuration also sets `allowJs: true`, `checkJs: false`,
and includes `src/**/*.js` because its TypeScript conversion happens in plan 4.

- [ ] **Step 5: Make the extension a workspace package and generate the root lock**

Rename the extension package to `@veriflow/vscode`, retain its product `displayName`, and replace direct root commands with workspace-safe scripts:

```json
{
  "name": "@veriflow/vscode",
  "scripts": {
    "compile:ts": "tsc -p ./",
    "bundle": "node ./scripts/build.mjs",
    "compile": "npm run compile:ts && npm run bundle",
    "test": "npm run compile && node ./scripts/run-tests.mjs"
  }
}
```

Run: `git rm veriflow-vscode/package-lock.json`

Run: `npm install --package-lock-only`

Expected: root `package-lock.json` contains all four workspaces and pinned parser dependencies.

- [ ] **Step 6: Point CI caching and commands at the root workspace**

In `.github/workflows/ci.yml`, set Node to `24.14.1`, cache `package-lock.json`, run `npm ci` at the repository root, and run extension tests with:

```yaml
- name: Test extension core
  run: npm test --workspace @veriflow/vscode
```

- [ ] **Step 7: Verify workspace installation and existing extension tests**

Run: `npm ci`

Expected: exit 0 with no nested extension lockfile.

Run: `npm test --workspace @veriflow/vscode`

Expected: all existing extension tests pass.

- [ ] **Step 8: Commit the workspace boundary**

```bash
git add package.json package-lock.json .nvmrc tsconfig.base.json packages veriflow-vscode/package.json veriflow-vscode/package-lock.json .github/workflows/ci.yml veriflow-vscode/src/test/core.test.ts
git commit -m "build: add root npm workspace"
```

### Task 3: Add deterministic shared build helpers

**Files:**
- Create: `scripts/lib/files.mjs`
- Create: `scripts/lib/build-config.mjs`
- Create: `scripts/build-web.mjs`
- Create: `scripts/build-vscode.mjs`
- Create: `scripts/verify-generated.mjs`
- Create: `veriflow-vscode/src/test/rootBuild.test.ts`
- Modify: `veriflow-vscode/scripts/run-tests.mjs`

- [ ] **Step 1: Write failing tests for deterministic options and generated verification**

```typescript
import * as assert from 'assert';
import * as path from 'path';

async function run(): Promise<void> {
    const root = path.resolve(__dirname, '../../..');
    const config = await import(path.join(root, 'scripts/lib/build-config.mjs'));
    assert.deepStrictEqual(config.browserBuildOptions(), {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
    });
}

run().then(() => console.log('root build tests passed'));
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run compile:ts --workspace @veriflow/vscode && node veriflow-vscode/out/test/rootBuild.test.js`

Expected: FAIL because `scripts/lib/build-config.mjs` is missing.

- [ ] **Step 3: Implement stable filesystem helpers**

`scripts/lib/files.mjs` must export these complete operations:

```javascript
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function recreate(directory) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
}

export async function copyTree(source, destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
}

export async function sha256(file) {
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
```

`scripts/lib/build-config.mjs` exports the exact object asserted by the test and a Node CJS variant targeting `node24`.

- [ ] **Step 4: Implement root build orchestration with explicit application descriptors**

`scripts/build-web.mjs` exports and consumes this descriptor list:

```javascript
export const webApplications = [
    {
        name: 'waveform',
        sourceRoot: 'packages/waveform-webview/src',
        staticFiles: ['index.html', 'index.css'],
        legacyScripts: ['viewer-transport.js', 'viewer-core.js', 'index.js'],
    },
    {
        name: 'schematic',
        sourceRoot: 'packages/schematic-webview/src',
        staticFiles: ['index.html', 'index.css'],
        entryPoint: 'index.ts',
    },
];
```

Resolve all paths from the repository root, recreate `web-dist`, copy static files, copy the three waveform legacy scripts without rewriting them, and bundle schematic `index.ts` with `browserBuildOptions()`.

`scripts/build-vscode.mjs` runs the extension Node bundle, recreates `veriflow-vscode/media/waveform` and `veriflow-vscode/media/schematic`, then copies from `web-dist`.

- [ ] **Step 5: Implement generated drift verification**

`scripts/verify-generated.mjs` must:

```javascript
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], {
    cwd: root,
    stdio: 'inherit',
});
execFileSync('git', ['diff', '--exit-code', '--', 'web-dist'], {
    cwd: root,
    stdio: 'inherit',
});
```

- [ ] **Step 6: Register the new test and verify helper behavior**

Add `rootBuild.test.js` to `veriflow-vscode/scripts/run-tests.mjs` in the deterministic test list.

Run: `npm run compile:ts --workspace @veriflow/vscode && node veriflow-vscode/out/test/rootBuild.test.js`

Expected: PASS and print `root build tests passed`.

- [ ] **Step 7: Commit shared build helpers**

```bash
git add scripts/lib scripts/build-web.mjs scripts/build-vscode.mjs scripts/verify-generated.mjs veriflow-vscode/src/test/rootBuild.test.ts veriflow-vscode/scripts/run-tests.mjs
git commit -m "build: add deterministic root build tools"
```

### Task 4: Make `web-dist` canonical without changing UI behavior

**Files:**
- Move: `veriflow-vscode/media/waveform/viewer.html` -> `packages/waveform-webview/src/index.html`
- Move: `veriflow-vscode/media/waveform/viewer.css` -> `packages/waveform-webview/src/index.css`
- Move: `veriflow-vscode/media/waveform/viewer.js` -> `packages/waveform-webview/src/index.js`
- Move: `veriflow-vscode/media/waveform/viewer-core.js` -> `packages/waveform-webview/src/viewer-core.js`
- Move: `veriflow-vscode/media/waveform/viewer-transport.js` -> `packages/waveform-webview/src/viewer-transport.js`
- Move: `veriflow-vscode/webview/schematic/index.html` -> `packages/schematic-webview/src/index.html`
- Move: `veriflow-vscode/webview/schematic/styles.css` -> `packages/schematic-webview/src/index.css`
- Move: `veriflow-vscode/webview/schematic/index.ts` -> `packages/schematic-webview/src/index.ts`
- Create: `web-dist/waveform/index.html`
- Create: `web-dist/waveform/index.css`
- Create: `web-dist/waveform/index.js`
- Create: `web-dist/waveform/viewer-core.js`
- Create: `web-dist/waveform/viewer-transport.js`
- Create: `web-dist/schematic/index.html`
- Create: `web-dist/schematic/index.css`
- Create: `web-dist/schematic/index.js`
- Modify: `.gitignore`
- Modify: `.gitattributes`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Create: `veriflow-vscode/src/test/webDistAssets.test.ts`

- [ ] **Step 1: Write the failing canonical asset test**

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
for (const relative of [
    'web-dist/waveform/index.html',
    'web-dist/waveform/index.css',
    'web-dist/waveform/index.js',
    'web-dist/schematic/index.html',
    'web-dist/schematic/index.css',
    'web-dist/schematic/index.js',
]) {
    assert.ok(fs.statSync(path.join(root, relative)).size > 0, `${relative} is empty`);
}
assert.ok(!fs.existsSync(path.join(root, 'veriflow-vscode/webview/schematic/index.ts')));
console.log('canonical web asset tests passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile:ts --workspace @veriflow/vscode && node veriflow-vscode/out/test/webDistAssets.test.js`

Expected: FAIL because `web-dist` does not exist.

- [ ] **Step 3: Move sources with history and normalize static names**

Run the eight `git mv` operations listed under **Files**. In `packages/waveform-webview/src/index.html`, keep the body fragment unchanged; it is embedded by hosts during this foundation. In `packages/schematic-webview/src/index.html`, change only `styles.css` to `index.css`.

Until plan 4 moves the serializable schematic types into the application
package, update the moved `index.ts` imports to the real temporary paths:

```typescript
import type {
    GraphNode,
    GraphNodeKind,
    GraphPin,
    NetworkEndpoint,
    SchematicGraph,
    SchematicNetwork,
} from '../../../veriflow-vscode/src/schematic/graphModel';
import {
    deriveFeedbackRoutes,
    SCHEMATIC_BASE_NODE_SIZE,
    SCHEMATIC_PIN_LAYOUT,
    SCHEMATIC_PORT_SIZE,
    schematicNodeSize,
    type SchematicLayout,
} from '../../../veriflow-vscode/src/schematic/layoutStore';
import type {
    HostEvent,
    WebviewCommand,
} from '../../../veriflow-vscode/src/schematic/protocol';
```

Update the `webviewSupport` import to the same `../../../veriflow-vscode/src`
root. Add a boundary assertion that these temporary extension imports exist
only in `packages/schematic-webview/src/index.ts`; plan 4 removes them.

- [ ] **Step 4: Generate and track canonical output**

Run: `npm run build:web`

Expected: unminified `web-dist/schematic/index.js` and byte-for-byte copied waveform JavaScript.

Add these attributes:

```gitattributes
web-dist/** text eol=lf
packages/*/src/** text eol=lf
```

Ignore generated extension copies, not canonical output:

```gitignore
veriflow-vscode/media/waveform/
veriflow-vscode/media/schematic/
.artifacts/
```

Ensure `.vscodeignore` still includes `media/waveform/**` and `media/schematic/**` by allowlisting generated package assets while excluding source packages from the VSIX.

- [ ] **Step 5: Update asset tests for canonical source ownership**

Replace schematic source assertions in `schematicAssets.test.ts` with `packages/schematic-webview/src`, and assert that generated bundles are unminified by checking for a stable exported function name rather than a minified token.

Register `webDistAssets.test.js` in `run-tests.mjs`.

- [ ] **Step 6: Verify deterministic artifacts twice**

Run: `npm run build:web`

Run: `git add -f web-dist && npm run verify:generated`

Expected: both commands exit 0 and `git diff -- web-dist` is empty after the second build.

- [ ] **Step 7: Commit canonical Web assets**

```bash
git add .gitignore .gitattributes packages/waveform-webview packages/schematic-webview web-dist veriflow-vscode/.vscodeignore veriflow-vscode/src/test/schematicAssets.test.ts veriflow-vscode/src/test/webDistAssets.test.ts veriflow-vscode/scripts/run-tests.mjs
git commit -m "build: make web-dist canonical"
```

### Task 5: Switch VS Code and Python asset consumers to generated copies and canonical assets

**Files:**
- Modify: `veriflow-vscode/scripts/build.mjs`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `src/presentation/gui/widgets/waveform_html.py`
- Modify: `VeriFlow.spec`
- Modify: `tests/test_core_services.py`
- Create: `tests/test_web_assets.py`

- [ ] **Step 1: Write failing Python canonical-path tests**

```python
from pathlib import Path

from src.presentation.gui.widgets.waveform_html import _waveform_assets_dir


def test_source_waveform_assets_use_canonical_web_dist() -> None:
    root = Path(__file__).resolve().parents[1]
    assert _waveform_assets_dir() == root / "web-dist" / "waveform"


def test_pyinstaller_collects_canonical_waveform_assets() -> None:
    root = Path(__file__).resolve().parents[1]
    spec = (root / "VeriFlow.spec").read_text(encoding="utf-8")
    assert "('web-dist/waveform', 'web-dist/waveform')" in spec
    assert "veriflow-vscode/media/waveform" not in spec
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_web_assets.py -v`

Expected: FAIL because Python still resolves extension media.

- [ ] **Step 3: Load canonical assets in Python source and bundled modes**

Replace `_waveform_assets_dir()` with:

```python
def _waveform_assets_dir() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        bundled = Path(bundled_root) / "web-dist" / "waveform"
        if bundled.exists():
            return bundled
    return Path(__file__).resolve().parents[4] / "web-dist" / "waveform"
```

Change `VeriFlow.spec` data collection to:

```python
('web-dist/waveform', 'web-dist/waveform'),
```

- [ ] **Step 4: Make extension bundling consume root-generated copies**

Remove schematic bundling and static-copy ownership from `veriflow-vscode/scripts/build.mjs`; it should bundle only extension Node entries and parser assets. `scripts/build-vscode.mjs` must run `build:web`, run the extension bundle, and copy canonical Web assets into extension media before VSIX packaging.

Update provider asset names from `viewer.css`, `viewer.html`, and `viewer.js` to `index.css`, `index.html`, and `index.js`. Keep exact runtime behavior and current string substitution in this foundation; plan 4 removes it.

- [ ] **Step 5: Run Python and extension regressions**

Run: `python -m pytest tests/test_web_assets.py tests/test_core_services.py -v`

Expected: PASS.

Run: `npm run build:vscode && npm test --workspace @veriflow/vscode`

Expected: PASS; generated media exists and current waveform/schematic tests retain behavior.

- [ ] **Step 6: Commit consumer changes**

```bash
git add scripts/build-vscode.mjs veriflow-vscode/scripts/build.mjs veriflow-vscode/src/waveformEditorProvider.ts veriflow-vscode/src/schematic/webviewSupport.ts src/presentation/gui/widgets/waveform_html.py VeriFlow.spec tests/test_web_assets.py tests/test_core_services.py
git commit -m "refactor: consume canonical web assets"
```

### Task 6: Build a real Tree-sitter SEA feasibility probe

**Files:**
- Create: `packages/parser-worker/src/probe.ts`
- Create: `packages/parser-worker/src/probe.test.ts`
- Create: `packages/parser-worker/tsconfig.test.json`
- Create: `packages/parser-worker/sea-config.json`
- Create: `scripts/build-parser-probe.mjs`
- Create: `scripts/smoke-parser-probe.mjs`
- Modify: `.gitignore`
- Test: `packages/parser-worker/src/probe.test.ts`

- [ ] **Step 1: Write the failing JSONL probe test**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleProbeRequest } from './probe';

test('probe parses SystemVerilog through both external WASM assets', async () => {
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId: 'probe-1',
        type: 'probe',
        payload: { source: 'module top(input logic clk); endmodule' },
    }, {
        runtimeWasmPath: process.env.VERIFLOW_RUNTIME_WASM!,
        languageWasmPath: process.env.VERIFLOW_LANGUAGE_WASM!,
    });
    assert.equal(response.ok, true);
    assert.equal(response.payload?.rootType, 'source_file');
    assert.equal(response.payload?.containsModule, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run typecheck --workspace @veriflow/parser-worker`

Expected: FAIL because `probe.ts` does not exist.

- [ ] **Step 3: Implement the bounded probe request and parser initialization**

`probe.ts` defines a single accepted request type, rejects source text over 1 MiB, initializes `web-tree-sitter` with the external runtime WASM, verifies language ABI 15, parses the source, and returns:

```typescript
export type ProbeResponse = {
    protocolVersion: 1;
    requestId: string;
    type: 'probe';
    ok: true;
    payload: {
        rootType: string;
        containsModule: boolean;
        languageAbi: number;
    };
} | {
    protocolVersion: 1;
    requestId: string;
    type: 'probe';
    ok: false;
    error: { code: string; message: string };
};
```

The executable entry reads resource paths relative to `process.execPath`, reserves stdout for one JSON response per input line, writes diagnostics to stderr, and exits on EOF.

Add `tsconfig.test.json` with `rootDir: "."`, `outDir: "dist-test"`,
`declaration: false`, and includes for `src/**/*.ts`. Change the package test
script to:

```json
{
  "test": "tsc -p tsconfig.test.json && node --test dist-test/src/*.test.js"
}
```

- [ ] **Step 4: Implement deterministic SEA building**

`scripts/build-parser-probe.mjs` must:

1. verify `process.version === 'v24.14.1'`;
2. bundle `probe.ts` to CJS with esbuild;
3. copy the exact pinned runtime and grammar WASM files;
4. invoke `node --experimental-sea-config packages/parser-worker/sea-config.json`;
5. copy `process.execPath` to `.artifacts/parser-worker/parser-worker.exe`;
6. invoke the local `postject` binary with `NODE_SEA_BLOB` and sentinel fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;
7. write a manifest containing Node, package, WASM size, and SHA-256 values.

The SEA configuration is:

```json
{
  "main": ".artifacts/parser-worker/probe.cjs",
  "output": ".artifacts/parser-worker/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
```

- [ ] **Step 5: Add the executable smoke script**

`scripts/smoke-parser-probe.mjs` spawns the EXE with piped stdio, sends exactly this line, closes stdin, and asserts one valid stdout line, empty protocol noise, exit code 0, and `containsModule: true`:

```json
{"protocolVersion":1,"requestId":"smoke-1","type":"probe","payload":{"source":"module top; endmodule"}}
```

- [ ] **Step 6: Run source and real-executable tests**

Run: `$env:VERIFLOW_RUNTIME_WASM=(Resolve-Path 'node_modules/web-tree-sitter/web-tree-sitter.wasm'); $env:VERIFLOW_LANGUAGE_WASM=(Resolve-Path 'node_modules/tree-sitter-systemverilog/tree-sitter-systemverilog.wasm'); npm test --workspace @veriflow/parser-worker`

Expected: PASS.

Run: `npm run build:parser`

Expected: `.artifacts/parser-worker/parser-worker.exe`, both WASM files, and `manifest.json` exist.

Run: `node scripts/smoke-parser-probe.mjs`

Expected: PASS against the real SEA executable.

- [ ] **Step 7: Commit the probe source, not the executable**

```bash
git add packages/parser-worker scripts/build-parser-probe.mjs scripts/smoke-parser-probe.mjs .gitignore
git commit -m "build: prove Tree-sitter Node SEA runtime"
```

### Task 7: Prove wheel lookup, hidden startup, and PyInstaller collection

**Files:**
- Create: `python-packages/veriflow-hdl-worker/pyproject.toml`
- Create: `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/__init__.py`
- Create: `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/runtime.py`
- Create: `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/bin/.gitkeep`
- Create: `python-packages/veriflow-hdl-worker/MANIFEST.in`
- Create: `scripts/build_parser_probe_wheel.py`
- Create: `scripts/parser_probe_entry.py`
- Create: `ParserProbe.spec`
- Create: `tests/test_parser_probe_package.py`

- [ ] **Step 1: Write failing installed-resource tests**

```python
import json
import subprocess

from veriflow_hdl_worker.runtime import runtime_paths, startup_info


def test_worker_wheel_exposes_verified_runtime_paths() -> None:
    paths = runtime_paths()
    manifest = json.loads(paths.manifest.read_text(encoding="utf-8"))
    assert paths.executable.is_file()
    assert paths.runtime_wasm.is_file()
    assert paths.language_wasm.is_file()
    assert manifest["protocolVersion"] == 1


def test_windows_startup_hides_console() -> None:
    info = startup_info()
    assert info["creationflags"] & subprocess.CREATE_NO_WINDOW
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_parser_probe_package.py -v`

Expected: FAIL because `veriflow_hdl_worker` is not installed.

- [ ] **Step 3: Create the platform-specific wheel contract**

`runtime.py` exposes only paths and startup flags:

```python
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Dict


@dataclass(frozen=True)
class RuntimePaths:
    executable: Path
    runtime_wasm: Path
    language_wasm: Path
    manifest: Path


def runtime_paths() -> RuntimePaths:
    root = Path(str(files("veriflow_hdl_worker").joinpath("bin")))
    return RuntimePaths(
        executable=root / "parser-worker.exe",
        runtime_wasm=root / "web-tree-sitter.wasm",
        language_wasm=root / "tree-sitter-systemverilog.wasm",
        manifest=root / "manifest.json",
    )


def startup_info() -> Dict[str, int]:
    return {"creationflags": subprocess.CREATE_NO_WINDOW}
```

The wheel name is `veriflow-hdl-worker`, version `1.3.2`, Python `>=3.8`, and tags are forced to `py3-none-win_amd64`. Package data includes `bin/*`.

- [ ] **Step 4: Build the wheel from real SEA output**

`scripts/build_parser_probe_wheel.py` must clean only `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/bin`, copy the four files from `.artifacts/parser-worker`, run `python -m build --wheel`, and assert exactly one `veriflow_hdl_worker-1.3.2-py3-none-win_amd64.whl` was produced.

- [ ] **Step 5: Add a PyInstaller entry that locates and executes the installed worker**

```python
from __future__ import annotations

import json
import subprocess

from veriflow_hdl_worker.runtime import runtime_paths, startup_info


def main() -> int:
    paths = runtime_paths()
    process = subprocess.Popen(
        [str(paths.executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        **startup_info(),
    )
    request = {
        "protocolVersion": 1,
        "requestId": "pyinstaller-probe",
        "type": "probe",
        "payload": {"source": "module packaged; endmodule"},
    }
    stdout, stderr = process.communicate(json.dumps(request) + "\n", timeout=10)
    response = json.loads(stdout)
    if process.returncode != 0 or not response.get("ok"):
        raise RuntimeError(stderr or stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`ParserProbe.spec` uses `collect_data_files('veriflow_hdl_worker')` so wheel resources are collected from the installed distribution, never from the source artifact directory.

- [ ] **Step 6: Build, install, and test the wheel in an isolated virtual environment**

Run: `python -m pip install build pyinstaller`

Run: `python scripts/build_parser_probe_wheel.py`

Run: `python -m pip install --force-reinstall python-packages/veriflow-hdl-worker/dist/veriflow_hdl_worker-1.3.2-py3-none-win_amd64.whl`

Run: `python -m pytest tests/test_parser_probe_package.py -v`

Expected: PASS.

Run: `pyinstaller ParserProbe.spec --noconfirm && dist/parser-probe.exe`

Expected: exit 0; Process Explorer or the automated window-enumeration assertion sees no console window for the child worker.

- [ ] **Step 7: Commit wheel source and package tests**

```bash
git add python-packages/veriflow-hdl-worker scripts/build_parser_probe_wheel.py scripts/parser_probe_entry.py ParserProbe.spec tests/test_parser_probe_package.py
git commit -m "build: prove parser worker wheel packaging"
```

### Task 8: Enforce the feasibility gate in CI and document the decision

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/architecture/hdl-runtime-feasibility.md`
- Modify: `README.md`
- Test: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a failing release-order assertion**

Add to `tests/test_parser_probe_package.py`:

```python
def test_windows_ci_runs_real_worker_before_python_tests() -> None:
    from pathlib import Path

    workflow = (
        Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml"
    ).read_text(encoding="utf-8")
    build_at = workflow.index("Build parser SEA probe")
    wheel_at = workflow.index("Build and install worker wheel")
    test_at = workflow.index("Run worker package tests")
    assert build_at < wheel_at < test_at
```

- [ ] **Step 2: Run the assertion to verify it fails**

Run: `python -m pytest tests/test_parser_probe_package.py::test_windows_ci_runs_real_worker_before_python_tests -v`

Expected: FAIL because the Windows feasibility job is absent.

- [ ] **Step 3: Add the Windows feasibility job**

The job must run on `windows-latest` and contain these ordered commands:

```yaml
- name: Install npm dependencies
  run: npm ci
- name: Build parser SEA probe
  run: npm run build:parser
- name: Smoke real parser SEA probe
  run: node scripts/smoke-parser-probe.mjs
- name: Build and install worker wheel
  run: |
    python -m pip install build pyinstaller pytest
    python scripts/build_parser_probe_wheel.py
    python -m pip install --force-reinstall (Get-ChildItem python-packages/veriflow-hdl-worker/dist/*.whl)
- name: Run worker package tests
  run: python -m pytest tests/test_parser_probe_package.py -v
- name: Verify PyInstaller collection
  run: |
    pyinstaller ParserProbe.spec --noconfirm
    dist/parser-probe.exe
```

- [ ] **Step 4: Record the actual feasibility evidence**

Create `docs/architecture/hdl-runtime-feasibility.md` containing:

```markdown
# HDL Runtime Feasibility Gate

- Builder OS: Windows x64
- Builder Node: 24.14.1
- web-tree-sitter: 0.26.11
- tree-sitter-systemverilog: 0.4.0
- Runtime assets: external, checksum-verified WASM files
- Transport exercised: UTF-8 JSONL over anonymous stdin/stdout pipes
- Distribution exercised: `py3-none-win_amd64` wheel
- Bundler exercised: PyInstaller collecting from the installed wheel

The gate passes only when the source probe, real SEA executable, installed
wheel, hidden child startup, and PyInstaller executable all parse
`module packaged; endmodule` successfully. Failure stops the migration and
requires revision of the approved architecture design.
```

Append the root build commands to README without changing end-user installation instructions.

- [ ] **Step 5: Run the complete foundation verification**

Run: `npm ci`

Run: `npm run build:web && npm run verify:generated`

Run: `npm run build:parser && node scripts/smoke-parser-probe.mjs`

Run: `python scripts/build_parser_probe_wheel.py`

Run: `python -m pytest`

Run: `npm test --workspace @veriflow/vscode`

Run: `pyinstaller ParserProbe.spec --noconfirm && dist/parser-probe.exe`

Expected: every command exits 0. If any SEA, WASM, wheel, hidden-startup, or PyInstaller check fails, stop here and revise `docs/superpowers/specs/2026-08-07-unified-web-and-hdl-runtime-design.md`; do not execute plan 2.

- [ ] **Step 6: Commit the feasibility gate**

```bash
git add .github/workflows/ci.yml docs/architecture/hdl-runtime-feasibility.md README.md tests/test_parser_probe_package.py
git commit -m "ci: enforce HDL runtime feasibility gate"
```

## Plan Completion Gate

Before moving to `2026-08-07-shared-hdl-core-and-protocol.md`, verify:

```bash
git status --short
npm run verify:generated
node scripts/smoke-parser-probe.mjs
python -m pytest
npm test --workspace @veriflow/vscode
dist/parser-probe.exe
```

Expected: clean status after committed generated artifacts and all commands exit 0. The committed repository contains source, manifests, and Web bundles only; it does not contain `parser-worker.exe`, SEA blobs, wheel files, PyInstaller output, or `.artifacts/`.

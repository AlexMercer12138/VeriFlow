# Shared HDL Core and Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the proven SystemVerilog parser, normalized models, incremental runtime, workspace index, and versioned protocol from VS Code-specific directories while preserving every extension behavior and regression.

**Architecture:** `@veriflow/hdl-core` owns host-neutral normalized models, preprocessing, source maps, Tree-sitter adaptation, and tree edits. `@veriflow/hdl-runtime` owns parser lifetime, retained trees, scheduling, and workspace indexing behind narrow file/store/parser interfaces. `@veriflow/hdl-protocol` owns serializable request/response envelopes and bounded runtime validators; the VS Code adapter carries those envelopes over `worker_threads` and keeps VS Code state/filesystem concerns inside the extension.

**Tech Stack:** TypeScript 5, Node.js 24 build tooling with Node 18-compatible VS Code bundles, web-tree-sitter 0.26.11, tree-sitter-systemverilog 0.4.0, worker_threads, Node test runner, existing VS Code test harness.

---

## File Structure

```text
packages/hdl-core/
  src/model.ts                 normalized serializable HDL models
  src/preprocessor.ts          defines/includes/composite source mapping
  src/positionMap.ts           byte/point/source position conversion
  src/treeEdit.ts              incremental tree edit calculation
  src/treeSitterAdapter.ts     Tree-sitter tree to HdlDocument adaptation
  src/workspaceModels.ts       serializable workspace summaries
  src/index.ts                 public exports only
  test/                        moved golden unit tests

packages/hdl-runtime/
  src/parserQueue.ts           interactive/background scheduling
  src/parserRuntime.ts         parser/WASM/cache/incremental tree lifecycle
  src/workspaceHdlIndex.ts     host-neutral workspace indexing
  src/dependencyAnalyzer.ts    shared dependency graph and compile ordering
  src/stores.ts                index-store interface and memory store
  src/index.ts                 public exports only
  test/                        runtime and workspace tests

packages/hdl-protocol/
  src/messages.ts              request/response type map
  src/validate.ts              bounded runtime validation
  src/errors.ts                stable error codes and payloads
  src/index.ts                 public exports only
  test/protocol.test.ts        malformed/bounds/version tests

veriflow-vscode/src/core/hdl/
  index.ts                     compatibility facade and client factory
  parserClient.ts              worker_threads transport and request cache
  parserWorker.ts              MessagePort adapter around HdlRuntime
  workspaceIndexStore.ts       VS Code Memento adapter
  legacyModelAdapter.ts        extension legacy ModuleInfo mapping
```

Raw Tree-sitter nodes and trees remain inside `parserRuntime.ts`. VS Code imports packages by their workspace package names, never through `packages/...` relative paths.

### Task 1: Lock package boundaries with compile-time contract tests

**Files:**
- Create: `packages/hdl-core/package.json`
- Create: `packages/hdl-core/tsconfig.json`
- Create: `packages/hdl-core/tsconfig.test.json`
- Create: `packages/hdl-runtime/package.json`
- Create: `packages/hdl-runtime/tsconfig.json`
- Create: `packages/hdl-runtime/tsconfig.test.json`
- Create: `packages/hdl-protocol/package.json`
- Create: `packages/hdl-protocol/tsconfig.json`
- Create: `packages/hdl-protocol/tsconfig.test.json`
- Create: `veriflow-vscode/src/test/hdlPackageBoundaries.test.ts`
- Modify: `veriflow-vscode/scripts/run-tests.mjs`

- [ ] **Step 1: Write a failing import-boundary test**

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const forbidden = /\b(?:vscode|PySide6|QWebChannel|acquireVsCodeApi)\b/;
for (const packageName of ['hdl-core', 'hdl-runtime', 'hdl-protocol']) {
    const sourceRoot = path.join(root, 'packages', packageName, 'src');
    assert.ok(fs.existsSync(sourceRoot), `${packageName} source is missing`);
    for (const file of fs.readdirSync(sourceRoot).filter(name => name.endsWith('.ts'))) {
        const source = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
        assert.doesNotMatch(source, forbidden, `${packageName}/${file} imports a host API`);
    }
}
console.log('HDL package boundary tests passed');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/hdlPackageBoundaries.test.js`

Expected: FAIL because the three package source directories do not exist.

- [ ] **Step 3: Add package manifests with explicit dependency direction**

`packages/hdl-core/package.json`:

```json
{
  "name": "@veriflow/hdl-core",
  "version": "1.3.2",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js"
  },
  "dependencies": {
    "web-tree-sitter": "0.26.11"
  }
}
```

`@veriflow/hdl-runtime` depends on `@veriflow/hdl-core` and `web-tree-sitter`; `@veriflow/hdl-protocol` depends only on `@veriflow/hdl-core`. None of the three packages depends on the `veriflow` extension workspace.

- [ ] **Step 4: Add strict build and test TypeScript configurations**

Each build configuration follows this complete shape, with package-specific `rootDir` and `outDir`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Each `tsconfig.test.json` includes both `src/**/*.ts` and `test/**/*.ts`, sets `rootDir` to `.`, `outDir` to `dist-test`, and disables declarations and composite output.

- [ ] **Step 5: Register and pass the boundary test with empty public indexes**

Create `src/index.ts` in all three packages with `export {};`, register `hdlPackageBoundaries.test.js` in the extension test runner, then run:

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/hdlPackageBoundaries.test.js`

Expected: PASS.

- [ ] **Step 6: Commit package boundaries**

```bash
git add packages/hdl-core packages/hdl-runtime packages/hdl-protocol veriflow-vscode/src/test/hdlPackageBoundaries.test.ts veriflow-vscode/scripts/run-tests.mjs package-lock.json
git commit -m "build: define shared HDL package boundaries"
```

### Task 2: Move normalized models, preprocessing, and source utilities into `hdl-core`

**Files:**
- Move: `veriflow-vscode/src/core/hdl/model.ts` -> `packages/hdl-core/src/model.ts`
- Move: `veriflow-vscode/src/core/hdl/preprocessor.ts` -> `packages/hdl-core/src/preprocessor.ts`
- Move: `veriflow-vscode/src/core/hdl/positionMap.ts` -> `packages/hdl-core/src/positionMap.ts`
- Move: `veriflow-vscode/src/core/hdl/treeEdit.ts` -> `packages/hdl-core/src/treeEdit.ts`
- Move: `veriflow-vscode/src/core/hdl/workspaceIndexTypes.ts` -> `packages/hdl-core/src/workspaceModels.ts`
- Move: `veriflow-vscode/src/test/hdlPreprocessor.test.ts` -> `packages/hdl-core/test/preprocessor.test.ts`
- Move: `veriflow-vscode/src/test/hdlPositionMap.test.ts` -> `packages/hdl-core/test/positionMap.test.ts`
- Modify: `packages/hdl-core/src/index.ts`
- Modify: imports in moved tests

- [ ] **Step 1: Add a failing public-model contract test**

Create `packages/hdl-core/test/publicApi.test.ts`:

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    canonicalizeSourceUri,
    computeTreeEdit,
    preprocessingFingerprint,
    type HdlDocument,
} from '../src';

test('core public API is host-neutral and deterministic', () => {
    const document: HdlDocument = {
        uri: 'file:///demo.sv',
        languageId: 'systemverilog',
        version: 1,
        textHash: 'sha256:test',
        lineEnding: '\n',
        preprocessingFingerprint: 'sha256:test',
        modules: [],
        interfaces: [],
        packages: [],
        directives: [],
        includes: [],
        diagnostics: [],
    };
    assert.equal(document.uri, canonicalizeSourceUri(document.uri));
    assert.equal(preprocessingFingerprint({ defines: {} }), preprocessingFingerprint({ defines: {} }));
    assert.equal(computeTreeEdit('a', 'a'), undefined);
});
```

- [ ] **Step 2: Run the package test to verify it fails**

Run: `npm test --workspace @veriflow/hdl-core`

Expected: FAIL because the public symbols are not exported.

- [ ] **Step 3: Move files with history and fix only package-local imports**

Use `git mv` for all files listed under **Files**. Change `workspaceModels.ts` to import `HdlDiagnostic` and `WidthValue` from `./model`; all other moved imports remain package-relative.

- [ ] **Step 4: Publish an explicit core API**

```typescript
export * from './model';
export * from './workspaceModels';
export {
    CompositeSourceMap,
    canonicalizeSourceUri,
    getPreprocessMetadataForWorker,
    isSourceUriWithinRoot,
    preprocessForParsing,
    preprocessingFingerprint,
} from './preprocessor';
export type {
    PreprocessMacroCandidate,
    PreprocessMetadata,
    PreprocessOptions,
    PreprocessResult,
    ResolvedIncludeInput,
} from './preprocessor';
export { PositionMap } from './positionMap';
export { computeTreeEdit } from './treeEdit';
export type { ParserTreeEdit } from './treeEdit';
```

- [ ] **Step 5: Run core golden tests**

Run: `npm test --workspace @veriflow/hdl-core`

Expected: all moved preprocessor, position-map, tree-edit, and public API tests pass.

- [ ] **Step 6: Commit core models and preprocessing**

```bash
git add packages/hdl-core veriflow-vscode/src/core/hdl veriflow-vscode/src/test
git commit -m "refactor: extract HDL models and preprocessing"
```

### Task 3: Move Tree-sitter adaptation and preserve golden parser coverage

**Files:**
- Move: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts` -> `packages/hdl-core/src/treeSitterAdapter.ts`
- Move: `veriflow-vscode/src/test/hdlAdapter.test.ts` -> `packages/hdl-core/test/treeSitterAdapter.test.ts`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-body.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-body.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-child.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-child.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-expression.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-expression.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-includes.sv` -> `packages/hdl-core/test/fixtures/hdl/schematic-includes.sv`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-instance-item.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-instance-item.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-port-prefix.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-port-prefix.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-ports.svh` -> `packages/hdl-core/test/fixtures/hdl/schematic-ports.svh`
- Move: `veriflow-vscode/src/test/fixtures/hdl/schematic-readonly.sv` -> `packages/hdl-core/test/fixtures/hdl/schematic-readonly.sv`
- Move: `veriflow-vscode/src/test/fixtures/hdl/structural.sv` -> `packages/hdl-core/test/fixtures/hdl/structural.sv`
- Create: `packages/hdl-core/test/helpers/fixturePath.ts`
- Modify: `packages/hdl-core/src/index.ts`
- Modify: fixture paths in extension schematic tests
- Modify: `tests/benchmarks/hdl-fixtures.json`

- [ ] **Step 1: Write a failing adapter export test**

Add to `publicApi.test.ts`:

```typescript
import { adaptTree, classifyTreeMacroUsages } from '../src';

test('Tree-sitter adapter exports stay available', () => {
    assert.equal(typeof adaptTree, 'function');
    assert.equal(typeof classifyTreeMacroUsages, 'function');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @veriflow/hdl-core`

Expected: FAIL because the adapter is still extension-owned.

- [ ] **Step 3: Move the adapter and decouple its request input**

Replace the adapter's dependency on the old worker protocol with this core input type in `treeSitterAdapter.ts`:

```typescript
export type HdlParseInput = {
    uri: string;
    version: number;
    text: string;
};
```

Change `adaptTree(tree, request, source)` to accept `HdlParseInput`. No transport fields such as request ID or priority enter the core.

- [ ] **Step 4: Move fixtures and use one package-local resolver**

```typescript
import * as path from 'node:path';

export function fixturePath(...parts: string[]): string {
    return path.join(__dirname, '..', 'fixtures', ...parts);
}
```

Extension tests that still need HDL fixtures resolve them from `packages/hdl-core/test/fixtures/hdl` through `veriflow-vscode/src/test/helpers/fixturePath.ts`; do not duplicate fixture files.
Update the two moved fixture entries in
`tests/benchmarks/hdl-fixtures.json` to
`packages/hdl-core/test/fixtures/hdl/structural.sv` and
`packages/hdl-core/test/fixtures/hdl/schematic-readonly.sv` so the recorded
benchmark contract remains resolvable after the move.

- [ ] **Step 5: Export and test the adapter**

Add:

```typescript
export { adaptTree, classifyTreeMacroUsages } from './treeSitterAdapter';
export type { AdapterSourceContext, HdlParseInput, TreeMacroUsageContext } from './treeSitterAdapter';
```

Run: `npm test --workspace @veriflow/hdl-core`

Expected: all adapter golden cases pass, including ANSI/non-ANSI ports, includes, generate constructs, expressions, and diagnostics.

- [ ] **Step 6: Run affected extension schematic tests**

Run: `npm test --workspace veriflow-vscode`

Expected: PASS using the single moved fixture set.

- [ ] **Step 7: Commit Tree-sitter adaptation**

```bash
git add packages/hdl-core veriflow-vscode/src/test
git commit -m "refactor: extract Tree-sitter HDL adapter"
```

### Task 4: Extract parser lifecycle and scheduling into `hdl-runtime`

**Files:**
- Move: `veriflow-vscode/src/core/hdl/parserQueue.ts` -> `packages/hdl-runtime/src/parserQueue.ts`
- Create: `packages/hdl-runtime/src/parserRuntime.ts`
- Create: `packages/hdl-runtime/src/types.ts`
- Move: `veriflow-vscode/src/test/hdlWorker.test.ts` -> `packages/hdl-runtime/test/parserRuntime.test.ts`
- Modify: `packages/hdl-runtime/src/index.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserWorker.ts`

- [ ] **Step 1: Write a failing in-process runtime test**

```typescript
import * as assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { HdlRuntime } from '../src';

const runtime = new HdlRuntime({
    runtimeWasmPath: process.env.VERIFLOW_RUNTIME_WASM!,
    languageWasmPath: process.env.VERIFLOW_LANGUAGE_WASM!,
    maxRetainedTrees: 8,
});
after(() => runtime.dispose());

test('runtime parses and reuses a document cache', async () => {
    const first = await runtime.parseDocument({
        uri: 'file:///runtime.sv',
        version: 1,
        text: 'module runtime(input logic clk); endmodule',
        priority: 'interactive',
        options: { defines: {}, cacheMode: 'document' },
    });
    const second = await runtime.parseDocument({
        uri: 'file:///runtime.sv',
        version: 2,
        text: 'module runtime(input logic clk, rst_n); endmodule',
        priority: 'interactive',
        options: { defines: {}, cacheMode: 'document' },
    });
    assert.equal(first.modules[0].ports.length, 1);
    assert.equal(second.modules[0].ports.length, 2);
});
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run: `$env:VERIFLOW_RUNTIME_WASM=(Resolve-Path 'node_modules/web-tree-sitter/web-tree-sitter.wasm'); $env:VERIFLOW_LANGUAGE_WASM=(Resolve-Path 'node_modules/tree-sitter-systemverilog/tree-sitter-systemverilog.wasm'); npm test --workspace @veriflow/hdl-runtime`

Expected: FAIL because `HdlRuntime` does not exist.

- [ ] **Step 3: Define the host-neutral runtime contract**

```typescript
import type { HdlDocument, PreprocessOptions } from '@veriflow/hdl-core';
import type { ParsePriority } from './parserQueue';

export type ParseDocumentInput = {
    uri: string;
    version: number;
    text: string;
    priority: ParsePriority;
    options: PreprocessOptions & { cacheMode?: 'document' | 'ephemeral' };
    signal?: AbortSignal;
};

export interface HdlDocumentParser {
    parseDocument(input: ParseDocumentInput): Promise<HdlDocument>;
    invalidate(uri: string): void;
    clearCache(): void;
}
```

- [ ] **Step 4: Extract parser logic from the worker into `HdlRuntime`**

Move parser initialization, ABI verification, macro diagnostics, incremental edits, retained-tree LRU behavior, and cleanup from `parserWorker.ts`. The class owns no `parentPort`, `workerData`, request IDs, or response envelopes. Cancellation checks `input.signal?.aborted` before initialization, before parsing, and before returning the document, and throws `HdlRuntimeCancelledError`.

Keep these explicit limits:

```typescript
export const DEFAULT_MAX_RETAINED_TREES = 8;
export const MAX_PARSE_TEXT_BYTES = 16 * 1024 * 1024;
```

- [ ] **Step 5: Export runtime API and execute golden runtime tests**

```typescript
export { HdlRuntime, HdlRuntimeCancelledError } from './parserRuntime';
export type { HdlRuntimeOptions } from './parserRuntime';
export { ParserRequestQueue } from './parserQueue';
export type { ParsePriority } from './parserQueue';
export type { HdlDocumentParser, ParseDocumentInput } from './types';
```

Run the environment-configured package test again.

Expected: PASS, including queue priority, cancellation, incremental edit, diagnostics, and resource cleanup cases.

- [ ] **Step 6: Commit the runtime extraction**

```bash
git add packages/hdl-runtime veriflow-vscode/src/core/hdl/parserWorker.ts veriflow-vscode/src/test
git commit -m "refactor: extract shared HDL parser runtime"
```

### Task 5: Extract workspace indexing behind host-neutral interfaces

**Files:**
- Move: `veriflow-vscode/src/core/hdl/workspaceHdlIndex.ts` -> `packages/hdl-runtime/src/workspaceHdlIndex.ts`
- Move: `veriflow-vscode/src/core/dependencyAnalyzer.ts` -> `packages/hdl-runtime/src/dependencyAnalyzer.ts`
- Create: `packages/hdl-runtime/src/stores.ts`
- Move: `veriflow-vscode/src/test/hdlWorkspaceIndex.test.ts` -> `packages/hdl-runtime/test/workspaceHdlIndex.test.ts`
- Move: `veriflow-vscode/src/test/helpers/workspaceIndexFixture.ts` -> `packages/hdl-runtime/test/helpers/workspaceIndexFixture.ts`
- Modify: `packages/hdl-runtime/src/index.ts`
- Modify: `veriflow-vscode/src/core/hdl/workspaceIndexStore.ts`
- Create: `veriflow-vscode/src/core/dependencyAnalyzer.ts`

- [ ] **Step 1: Write a failing memory-store test**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryWorkspaceIndexStore } from '../src';

test('memory store commits only the matching parser fingerprint', async () => {
    const store = new MemoryWorkspaceIndexStore();
    const value = { schemaVersion: 1 as const, parserFingerprint: 'parser-a', files: [] };
    await store.save(value);
    assert.deepStrictEqual(store.load('parser-a'), value);
    assert.equal(store.load('parser-b'), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @veriflow/hdl-runtime`

Expected: FAIL because the store interface and implementation are absent.

- [ ] **Step 3: Define store and file-host boundaries**

```typescript
import type { PersistedWorkspaceIndex } from '@veriflow/hdl-core';

export interface WorkspaceIndexStore {
    load(parserFingerprint: string): PersistedWorkspaceIndex | undefined;
    save(value: PersistedWorkspaceIndex): Promise<void>;
    stage(value: PersistedWorkspaceIndex): Promise<void>;
    discardStaged(): Promise<void>;
    clear(): Promise<void>;
}

export class MemoryWorkspaceIndexStore implements WorkspaceIndexStore {
    private committed: PersistedWorkspaceIndex | undefined;
    private staged: PersistedWorkspaceIndex | undefined;
    load(fingerprint: string): PersistedWorkspaceIndex | undefined {
        return this.committed?.parserFingerprint === fingerprint ? this.committed : undefined;
    }
    async save(value: PersistedWorkspaceIndex): Promise<void> { this.committed = value; }
    async stage(value: PersistedWorkspaceIndex): Promise<void> { this.staged = value; }
    async discardStaged(): Promise<void> { this.staged = undefined; }
    async clear(): Promise<void> { this.committed = undefined; this.staged = undefined; }
}
```

- [ ] **Step 4: Move the workspace index and replace concrete client/store types**

`WorkspaceHdlIndexOptions.parser` becomes `HdlDocumentParser`; calls change from `parser.parse(...)` to `parser.parseDocument({...})`. `WorkspaceHdlIndexOptions.store` becomes the interface above. Keep `findFiles`, `readFile`, include candidates, and include resolution as injected host operations.

- [ ] **Step 5: Move dependency resolution and use URI-based shared results**

Add this serializable model to `@veriflow/hdl-core/workspaceModels.ts`:

```typescript
export type HdlDependencyAnalysis = {
    topModule: string;
    topDefinitionKey: string;
    fileUris: string[];
    missingModules: string[];
    ambiguousModules: Record<string, string[]>;
    moduleMap: Record<string, string>;
    depGraph: Record<string, string[]>;
};
```

Move the traversal, duplicate binding, include-before-owner ordering, and
deterministic sorting from the extension analyzer into runtime
`dependencyAnalyzer.ts`. The shared analyzer returns file URIs and imports no
extension `DependencyResult`. Recreate the extension file as a thin adapter
that delegates to the shared analyzer and converts file URIs to the existing
path-based `DependencyResult`.

- [ ] **Step 6: Keep the VS Code Memento adapter extension-owned**

Change `veriflow-vscode/src/core/hdl/workspaceIndexStore.ts` to implement the
shared `WorkspaceIndexStore` interface while retaining the current complete
fingerprint-key, persisted-value validation, staging, save, discard, and clear
implementation. Its imports become:

```typescript
import type { PersistedWorkspaceIndex } from '@veriflow/hdl-core';
import type { WorkspaceIndexStore as WorkspaceIndexStoreContract } from '@veriflow/hdl-runtime';
```

The Memento adapter may use Node crypto and VS Code-like state, but shared runtime files may not import it.

- [ ] **Step 7: Run workspace and extension index regressions**

Run: `npm test --workspace @veriflow/hdl-runtime`

Expected: all moved indexing, invalidation, include, duplicate, persistence,
dependency graph, ambiguous binding, missing module, and deterministic
compile-order tests pass.

Run: `npm test --workspace veriflow-vscode`

Expected: existing dependency index and schematic integration tests pass.

- [ ] **Step 8: Commit workspace extraction**

```bash
git add packages/hdl-runtime veriflow-vscode/src/core/hdl/workspaceIndexStore.ts veriflow-vscode/src/test
git commit -m "refactor: extract shared HDL workspace index"
```

### Task 6: Define the versioned logical protocol and bounded validation

**Files:**
- Create: `packages/hdl-protocol/src/messages.ts`
- Create: `packages/hdl-protocol/src/errors.ts`
- Create: `packages/hdl-protocol/src/validate.ts`
- Modify: `packages/hdl-protocol/src/index.ts`
- Create: `packages/hdl-protocol/test/protocol.test.ts`
- Delete: `veriflow-vscode/src/core/hdl/protocol.ts`

- [ ] **Step 1: Write failing envelope and size-limit tests**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest, PROTOCOL_VERSION } from '../src';

test('request validator accepts a bounded parse request', () => {
    const request = parseRequest({
        protocolVersion: PROTOCOL_VERSION,
        requestId: '42',
        type: 'parseDocument',
        payload: {
            uri: 'file:///top.sv',
            version: 1,
            text: 'module top; endmodule',
            priority: 'interactive',
            options: { defines: {}, cacheMode: 'document' },
        },
    });
    assert.equal(request.type, 'parseDocument');
});

test('request validator rejects oversized source', () => {
    assert.throws(() => parseRequest({
        protocolVersion: 1,
        requestId: 'large',
        type: 'parseDocument',
        payload: {
            uri: 'file:///large.sv',
            version: 1,
            text: 'x'.repeat(16 * 1024 * 1024 + 1),
            priority: 'interactive',
            options: { defines: {} },
        },
    }), /HDL_REQUEST_TOO_LARGE/);
});
```

- [ ] **Step 2: Run protocol tests to verify they fail**

Run: `npm test --workspace @veriflow/hdl-protocol`

Expected: FAIL because protocol types and validators are absent.

- [ ] **Step 3: Define exact request operations**

`messages.ts` defines `PROTOCOL_VERSION = 1` and these payloads:

```typescript
export type InitializePayload = {
    workspaceRoots: string[];
    includeDirs: string[];
    libraryDirs: string[];
    defines: Record<string, string | true>;
    encoding: 'utf-8';
    limits: {
        maxLineBytes: number;
        maxDocumentBytes: number;
        maxWorkspaceFiles: number;
        maxWorkspaceBytes: number;
        maxStderrBytes: number;
    };
};

export type ParseDocumentPayload = {
    uri: string;
    version: number;
    text: string;
    priority: 'interactive' | 'background';
    options: {
        defines: Record<string, string | true>;
        resolvedIncludes?: Array<{
            fromUri: string;
            rawPath: string;
            resolvedUri: string;
            text: string;
        }>;
        maxIncludeDepth?: number;
        cacheMode?: 'document' | 'ephemeral';
    };
};

export type IndexWorkspacePayload = { roots: string[]; refresh: 'persistent' | 'transient' };
export type AnalyzeDependenciesPayload = { topModule: string };
export type GetModulePayload = { name: string; uri?: string };
export type CancelPayload = { targetRequestId: string };
export type DisposePayload = Record<string, never>;
```

`HdlRequest` is a discriminated union for `initialize`, `parseDocument`, `indexWorkspace`, `analyzeDependencies`, `getModule`, `cancel`, and `dispose`. All members contain `protocolVersion`, `requestId`, `type`, and `payload`.

- [ ] **Step 4: Define response and error envelopes**

```typescript
export type ProtocolError = {
    code:
        | 'HDL_INVALID_REQUEST'
        | 'HDL_REQUEST_TOO_LARGE'
        | 'HDL_NOT_INITIALIZED'
        | 'HDL_NOT_FOUND'
        | 'HDL_LIMIT_EXCEEDED'
        | 'HDL_CANCELLED'
        | 'HDL_RUNTIME_FAILURE';
    message: string;
    details?: Record<string, unknown>;
};

export type HdlSuccessResponse<TType extends HdlRequest['type'], TPayload> = {
    protocolVersion: 1;
    requestId: string;
    type: TType;
    ok: true;
    payload: TPayload;
};

export type HdlFailureResponse<TType extends HdlRequest['type'] = HdlRequest['type']> = {
    protocolVersion: 1;
    requestId: string;
    type: TType;
    ok: false;
    error: ProtocolError;
};
```

Define successful payloads using `HdlDocument`, `HdlDefinitionSummary`, diagnostics, workspace file summaries, dependency graph, missing modules, and compile-order URIs from `@veriflow/hdl-core`. No Tree-sitter objects appear.

Use these exact success payload shapes consistently in both transports:

```typescript
export type SuccessPayloads = {
    initialize: {
        protocolVersion: 1;
        coreVersion: string;
        grammarVersion: string;
        runtimeWasmSha256: string;
        grammarWasmSha256: string;
        capabilities: Array<Exclude<HdlRequest['type'], 'initialize'>>;
    };
    parseDocument: { document: HdlDocument };
    indexWorkspace: {
        files: HdlFileSummary[];
        definitions: HdlDefinitionSummary[];
        duplicateGroups: Array<{ name: string; definitions: HdlDefinitionSummary[] }>;
        diagnostics: HdlDiagnostic[];
    };
    analyzeDependencies: HdlDependencyAnalysis;
    getModule: { definition: HdlDefinitionSummary };
    cancel: { cancelled: boolean };
    dispose: { disposed: true };
};
```

- [ ] **Step 5: Implement bounded runtime parsing without coercion**

`parseRequest(value: unknown)` verifies plain records, exact protocol version,
request ID length 1-128, known operation, arrays of strings, UTF-8-only
encoding, finite non-negative versions/limits, define values, maximum 16 MiB
primary source text, no more than 256 resolved includes, a combined 16 MiB
resolved-include text budget, include depth from 1 through 64, and no more than
256 roots/include/library directories. Unknown top-level keys are rejected so
malformed messages cannot silently change meaning.

`parseResponse(value: unknown)` validates the common envelope, matching success/error exclusivity, and bounded error details. Export `makeSuccess` and `makeFailure` helpers so hosts do not hand-build envelopes.

- [ ] **Step 6: Run malformed-input and typechecking tests**

Run: `npm test --workspace @veriflow/hdl-protocol`

Expected: PASS for valid operations and rejection of wrong versions, unknown types, oversized text, invalid limits, both payload/error present, and neither payload/error present.

Run: `npm run typecheck --workspace @veriflow/hdl-core && npm run typecheck --workspace @veriflow/hdl-runtime && npm run typecheck --workspace @veriflow/hdl-protocol`

Expected: PASS with no dependency cycles.

- [ ] **Step 7: Commit the protocol**

```bash
git add packages/hdl-protocol veriflow-vscode/src/core/hdl/protocol.ts package-lock.json
git commit -m "feat: define shared HDL protocol"
```

### Task 7: Adapt VS Code worker_threads to the shared runtime and protocol

**Files:**
- Modify: `veriflow-vscode/src/core/hdl/parserWorker.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserClient.ts`
- Modify: `veriflow-vscode/src/core/hdl/index.ts`
- Modify: `veriflow-vscode/src/test/hdlParserClient.test.ts`
- Modify: `veriflow-vscode/src/test/helpers/hdlWorkerFixture.ts`
- Create: `veriflow-vscode/src/test/hdlSharedProtocol.test.ts`
- Modify: `veriflow-vscode/scripts/build.mjs`

- [ ] **Step 1: Write a failing MessagePort protocol test**

```typescript
import * as assert from 'assert';
import { HdlParserClient } from '../core/hdl/parserClient';

async function testSharedEnvelope(): Promise<void> {
    const posted: unknown[] = [];
    const worker = createFakeWorker(message => posted.push(message));
    const client = new HdlParserClient({
        workerPath: 'worker.js',
        runtimeWasmPath: 'runtime.wasm',
        languageWasmPath: 'language.wasm',
        createWorker: () => worker,
    });
    void client.parse('file:///top.sv', 1, 'module top; endmodule', { defines: {} });
    const request = posted.find((item: any) => item.type === 'parseDocument') as any;
    assert.strictEqual(request.protocolVersion, 1);
    assert.strictEqual(request.payload.uri, 'file:///top.sv');
    await client.dispose();
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/hdlSharedProtocol.test.js`

Expected: FAIL because the client still posts the legacy `parse` message.

- [ ] **Step 3: Make `parserWorker.ts` a transport adapter only**

The worker creates one `HdlRuntime` from `workerData` asset paths, validates each incoming `HdlRequest`, maps `parseDocument` to `runtime.parseDocument`, owns one `AbortController` per active request, and maps errors with `makeFailure`. It supports `initialize`, `parseDocument`, `cancel`, and `dispose`; unsupported workspace operations return `HDL_INVALID_REQUEST` because VS Code keeps workspace file access in its host index.

The worker sends protocol envelopes only:

```typescript
parentPort.on('message', async (raw: unknown) => {
    const request = parseRequest(raw);
    const response = await dispatchWorkerRequest(request, runtime, activeRequests);
    if (response) parentPort.postMessage(response);
});
```

- [ ] **Step 4: Adapt the client while preserving its public API and cache semantics**

Keep `parse(uri, version, text, options, priority, signal)` so extension consumers do not churn. Internally send `parseDocument` with `PROTOCOL_VERSION`, validate responses, use `ok` rather than legacy response type, and send `cancel` with a new request ID plus `targetRequestId` in the payload.

Worker creation still receives asset paths in `workerData`; the first logical message is an `initialize` request with empty workspace roots, configured defines, UTF-8, and explicit default limits. Queue parse requests behind successful initialization.

- [ ] **Step 5: Bundle the shared package entry**

Keep the worker bundle output at `dist/workers/hdlParserWorker.js`. esbuild follows npm workspace links and bundles `@veriflow/hdl-core`, `@veriflow/hdl-runtime`, and `@veriflow/hdl-protocol`; no shared package runtime JavaScript is shipped separately in the VSIX.

- [ ] **Step 6: Run client, worker, parser asset, and full extension tests**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/hdlParserClient.test.js && node veriflow-vscode/out/test/hdlSharedProtocol.test.js`

Expected: PASS for lazy startup, cache hits, invalidation, cancellation, disposal, worker failure, and shared envelopes.

Run: `npm test --workspace veriflow-vscode`

Expected: all extension regressions pass.

- [ ] **Step 7: Commit the worker adapter**

```bash
git add veriflow-vscode/src/core/hdl veriflow-vscode/src/test veriflow-vscode/scripts/build.mjs
git commit -m "refactor: use shared HDL runtime in VS Code"
```

### Task 8: Replace extension-internal imports with package public APIs

**Files:**
- Modify: `veriflow-vscode/src/core/dependencyAnalyzer.ts`
- Modify: `veriflow-vscode/src/core/moduleInstantiationChoices.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/testbenchPanel.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/graphModel.ts`
- Modify: `veriflow-vscode/src/schematic/navigationRegistry.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorSupport.ts`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/test/hdlConfig.test.ts`
- Modify: `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`
- Modify: `veriflow-vscode/src/test/hdlParserClient.test.ts`
- Modify: `veriflow-vscode/src/test/moduleInstantiationLifecycle.test.ts`
- Modify: `veriflow-vscode/src/test/schematicEditorProvider.test.ts`
- Modify: `veriflow-vscode/src/test/schematicGraph.test.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`
- Modify: `veriflow-vscode/src/test/testbenchPanel.test.ts`
- Modify: `veriflow-vscode/src/core/hdl/legacyModelAdapter.ts`
- Modify: `veriflow-vscode/src/core/hdl/index.ts`
- Delete: superseded files under `veriflow-vscode/src/core/hdl/`

- [ ] **Step 1: Add a failing legacy-import scan**

Extend `hdlPackageBoundaries.test.ts`:

```typescript
const extensionSource = path.join(root, 'veriflow-vscode', 'src');
const allowedFacade = path.normalize(path.join(extensionSource, 'core', 'hdl', 'index.ts'));

function walkTypeScriptFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkTypeScriptFiles(item);
        return entry.isFile() && item.endsWith('.ts') ? [item] : [];
    });
}

for (const file of walkTypeScriptFiles(extensionSource)) {
    if (path.normalize(file) === allowedFacade) continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
        source,
        /(?:\.\.\/|\.\/)core\/hdl\/(?:model|preprocessor|workspaceHdlIndex|workspaceIndexTypes|treeEdit)/,
        file
    );
}
```

- [ ] **Step 2: Run the scan to verify it fails**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/hdlPackageBoundaries.test.js`

Expected: FAIL and list current deep imports.

- [ ] **Step 3: Update production imports by ownership**

Use:

```typescript
import type { HdlDiagnostic, HdlDocument, ModuleModel, SourceSpan } from '@veriflow/hdl-core';
import { canonicalizeSourceUri } from '@veriflow/hdl-core';
import type { HdlDefinitionSummary } from '@veriflow/hdl-core';
import { WorkspaceHdlIndex } from '@veriflow/hdl-runtime';
```

Keep `WorkspaceIndexStore`, `HdlParserClient`, and `legacyModelAdapter` imported from the extension facade because they are host adapters.

- [ ] **Step 4: Reduce the extension facade to adapters and compatibility exports**

```typescript
export * from '@veriflow/hdl-core';
export { WorkspaceHdlIndex } from '@veriflow/hdl-runtime';
export type {
    DuplicateDefinitionGroup,
    WorkspaceHdlIncludeWatchContext,
    WorkspaceHdlIndexOptions,
    WorkspaceHdlRefreshMode,
    WorkspaceIndexInvalidation,
} from '@veriflow/hdl-runtime';
export { HdlParserClient, HdlParserCancelledError, HdlParserDisposedError } from './parserClient';
export { WorkspaceIndexStore } from './workspaceIndexStore';
export { toModuleInfo } from './legacyModelAdapter';
```

- [ ] **Step 5: Update tests and delete superseded extension files**

Package-level behavior tests remain in packages. Extension integration tests import public package names or the extension facade; no test reaches into package source relative paths. Delete only files that were moved and have no adapter responsibility.

- [ ] **Step 6: Run all TypeScript and generated-artifact verification**

Run: `npm run typecheck --workspace @veriflow/hdl-core && npm run typecheck --workspace @veriflow/hdl-runtime && npm run typecheck --workspace @veriflow/hdl-protocol`

Run: `npm test --workspace @veriflow/hdl-core && npm test --workspace @veriflow/hdl-runtime && npm test --workspace @veriflow/hdl-protocol`

Run: `npm test --workspace veriflow-vscode`

Run: `npm run verify:generated`

Expected: every command exits 0 and the legacy import scan finds no deep shared implementation imports.

- [ ] **Step 7: Commit package import cleanup**

```bash
git add packages veriflow-vscode package-lock.json
git commit -m "refactor: consume shared HDL package APIs"
```

## Plan Completion Gate

Run:

```bash
npm ci
npm test --workspace @veriflow/hdl-core
npm test --workspace @veriflow/hdl-runtime
npm test --workspace @veriflow/hdl-protocol
npm test --workspace veriflow-vscode
npm run build:vscode
npm run verify:generated
git status --short
```

Expected: all commands pass, status is clean after commits, VS Code retains lazy `worker_threads` parsing, and `rg "from ['\"].*core/hdl/(model|preprocessor|workspaceHdlIndex|workspaceIndexTypes|treeSitterAdapter)" veriflow-vscode/src` returns no matches. Do not begin the Python sidecar plan until this gate passes.

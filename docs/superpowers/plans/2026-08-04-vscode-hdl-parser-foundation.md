# VS Code HDL Parser Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lazy, worker-hosted Tree-sitter SystemVerilog parser and VeriFlow-owned normalized HDL document model without changing existing user-facing HDL behavior.

**Architecture:** Bundle `web-tree-sitter` into a dedicated Node worker and copy only the runtime and SystemVerilog WASM files into the VSIX. The worker converts CST nodes into serializable TypeScript models; an extension-host client owns request cancellation and document-version caching. Raw Tree-sitter node names remain isolated in the worker adapter.

**Tech Stack:** TypeScript 5, Node worker_threads, web-tree-sitter 0.26.11, tree-sitter-systemverilog 0.4.0, esbuild, Node assert tests, VSCE

---

## Test File Convention

The extension stays TypeScript/CommonJS. In every new `*.test.ts` file in this and later plans, keep imports at top level, place the shown test body inside `async function main(): Promise<void>`, and end with:

```typescript
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

No test may use top-level `await`; this keeps every intermediate commit compatible with the existing `tsconfig.json`.

## File Structure

- Create `veriflow-vscode/scripts/build.mjs`: bundle extension and HDL worker, then copy pinned WASM and licenses.
- Create `veriflow-vscode/scripts/run-tests.mjs`: execute every compiled top-level `*.test.js` file deterministically.
- Create `veriflow-vscode/.nvmrc`: pin the build environment to Node 20.
- Modify `veriflow-vscode/src/waveformEditorProvider.ts`: point the bundled extension at the bundled waveform worker.
- Create `veriflow-vscode/src/core/hdl/model.ts`: serializable normalized HDL types.
- Create `veriflow-vscode/src/core/hdl/positionMap.ts`: UTF-8 byte offset to UTF-16 offset conversion.
- Create `veriflow-vscode/src/core/hdl/protocol.ts`: worker request and response discriminated unions.
- Create `veriflow-vscode/src/core/hdl/parserQueue.ts`: stable interactive-before-background request scheduling.
- Create `veriflow-vscode/src/core/hdl/treeEdit.ts`: UTF-8 Tree Edit calculation over preprocessed text.
- Create `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`: the only CST-aware model adapter.
- Create `veriflow-vscode/src/core/hdl/parserWorker.ts`: lazy Tree-sitter runtime and prioritized parse loop.
- Create `veriflow-vscode/src/core/hdl/parserClient.ts`: worker lifecycle, request matching, cancellation, and cache.
- Create `veriflow-vscode/src/core/hdl/preprocessor.ts`: active-branch mask and original-source mapping.
- Create `veriflow-vscode/src/core/hdl/index.ts`: public HDL parser exports.
- Create `veriflow-vscode/src/test/hdlParser.test.ts`: parser foundation regression tests.
- Create `veriflow-vscode/src/test/helpers/hdlWorkerFixture.ts`: real-WASM parser helper shared by HDL tests.
- Create `veriflow-vscode/src/test/helpers/fixturePath.ts`: resolve source fixtures without relying on `tsc` to copy HDL files.
- Modify `veriflow-vscode/package.json`: dependencies, scripts, and `veriflow.defines` setting.
- Modify `veriflow-vscode/package-lock.json`: locked parser and build dependencies.
- Modify `veriflow-vscode/tsconfig.json`: keep worker and tests in the type-check build.
- Modify `veriflow-vscode/.vscodeignore`: package copied parser assets and exclude source maps.
- Modify `.gitignore`: ignore generated extension bundles under `veriflow-vscode/dist/`.
- Modify `veriflow-vscode/src/core/index.ts`: export normalized models and parser client.
- Modify `veriflow-vscode/src/extension.ts`: create and dispose one parser client without migrating consumers yet.
- Create `veriflow-vscode/THIRD_PARTY_NOTICES.md`: Tree-sitter grammar/runtime attribution.

### Task 1: Reproducible Parser Asset Build

**Files:**
- Create: `veriflow-vscode/scripts/build.mjs`
- Create: `veriflow-vscode/scripts/run-tests.mjs`
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/package-lock.json`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `.gitignore`
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Create: `veriflow-vscode/.nvmrc`
- Create: `veriflow-vscode/THIRD_PARTY_NOTICES.md`
- Create: `veriflow-vscode/src/test/parserAssets.test.ts`

- [ ] **Step 1: Add a failing asset-manifest test**

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const extensionRoot = path.resolve(__dirname, '..', '..');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');

assert.ok(fs.statSync(path.join(parserRoot, 'tree-sitter-systemverilog.wasm')).size > 1_000_000);
assert.ok(fs.statSync(path.join(parserRoot, 'web-tree-sitter.wasm')).size > 100_000);
const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(sha256(path.join(parserRoot, 'tree-sitter-systemverilog.wasm')), 'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d');
assert.strictEqual(sha256(path.join(parserRoot, 'web-tree-sitter.wasm')), '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc');
assert.ok(fs.readFileSync(path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('tree-sitter-systemverilog'));
console.log('parser asset tests passed');
```

- [ ] **Step 2: Run the test to verify missing assets fail**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/parserAssets.test.js`

Expected: FAIL with `ENOENT` for `media/parsers/tree-sitter-systemverilog.wasm`.

- [ ] **Step 3: Add pinned dependencies and the build script**

Add these package entries and preserve all existing scripts:

```json
{
  "engines": {
    "vscode": "^1.82.0"
  },
  "dependencies": {
    "web-tree-sitter": "0.26.11"
  },
  "devDependencies": {
    "@types/vscode": "^1.82.0",
    "esbuild": "0.28.1",
    "tree-sitter-systemverilog": "0.4.0"
  },
  "scripts": {
    "compile:ts": "tsc -p ./",
    "bundle": "node ./scripts/build.mjs",
    "compile": "npm run compile:ts && npm run bundle",
    "test": "npm run compile && node ./scripts/run-tests.mjs"
  }
}
```

Create `.nvmrc` containing `20`. VS Code 1.82 is the minimum supported editor because its extension host provides Node 18, which is the runtime target for the bundled extension and parser worker. Node 20 is the repository build/test/packaging environment because the pinned `@antv/x6` 3.1.7 frontend dependency added in phase 3 declares Node 20 for installation; do not add `engines.node` to the VS Code extension manifest. Add a manifest test asserting `engines.vscode === '^1.82.0'`, absence of `engines.node`, `.nvmrc === '20'`, and esbuild target `node18`; later CI must build on Node 20 and launch Extension Host tests on VS Code 1.82 and the current stable release.

Create `scripts/run-tests.mjs`:

```javascript
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const testRoot = path.join(process.cwd(), 'out', 'test');
const files = (await readdir(testRoot))
  .filter(name => name.endsWith('.test.js'))
  .sort();
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(testRoot, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`passed ${files.length} test files`);
```

Implement `scripts/build.mjs` as:

```javascript
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const parserAssets = path.join(root, 'media', 'parsers');
const expectedHashes = {
  'tree-sitter-systemverilog.wasm': 'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d',
  'web-tree-sitter.wasm': '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc',
};

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'workers'), { recursive: true });
await mkdir(parserAssets, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    outfile: path.join(dist, 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, 'src', 'core', 'hdl', 'parserWorker.ts')],
    outfile: path.join(dist, 'workers', 'hdlParserWorker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, 'src', 'core', 'waveformWorker.ts')],
    outfile: path.join(dist, 'workers', 'waveformWorker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
  }),
]);

await copyFile(
  path.join(root, 'node_modules', 'tree-sitter-systemverilog', 'tree-sitter-systemverilog.wasm'),
  path.join(parserAssets, 'tree-sitter-systemverilog.wasm'),
);

await copyFile(
  path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  path.join(parserAssets, 'web-tree-sitter.wasm'),
);

for (const [name, expected] of Object.entries(expectedHashes)) {
  const actual = createHash('sha256').update(await readFile(path.join(parserAssets, name))).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: ${actual}`);
}

const grammarLicense = await readFile(path.join(root, 'node_modules', 'tree-sitter-systemverilog', 'LICENSE'), 'utf8');
const runtimeLicense = await readFile(path.join(root, 'node_modules', 'web-tree-sitter', 'LICENSE'), 'utf8');
await writeFile(
  path.join(root, 'THIRD_PARTY_NOTICES.md'),
  `# Third-Party Notices\n\n## tree-sitter-systemverilog 0.4.0\n\n${grammarLicense}\n\n## web-tree-sitter 0.26.11\n\n${runtimeLicense}`,
  'utf8',
);
```

Set `package.json.main` to `./dist/extension.js`. In `waveformEditorProvider.ts`, construct `WaveformWorkerClient` with `workerPath: path.join(this._context.extensionPath, 'dist', 'workers', 'waveformWorker.js')`; direct compiled unit tests keep using the existing injected/default `out/core/waveformWorker.js` path.

Append `out/**`, `scripts/**`, and `**/*.map` to `.vscodeignore`. The VSIX runtime comes only from `dist/extension.js`, `dist/workers/hdlParserWorker.js`, `dist/workers/waveformWorker.js`, approved media assets, manifests, README/license/notices; do not ignore `dist/**`, `media/parsers/**`, or `THIRD_PARTY_NOTICES.md`. Append `veriflow-vscode/dist/` to the repository `.gitignore`.

- [ ] **Step 4: Install, build, and verify assets**

Run: `cd veriflow-vscode && npm install && npm run compile && node ./out/test/parserAssets.test.js`

Expected: `parser asset tests passed` and both WASM files exist under `media/parsers`.

- [ ] **Step 5: Commit the build foundation**

```bash
git add .gitignore veriflow-vscode/.nvmrc veriflow-vscode/package.json veriflow-vscode/package-lock.json veriflow-vscode/.vscodeignore veriflow-vscode/scripts/build.mjs veriflow-vscode/scripts/run-tests.mjs veriflow-vscode/src/waveformEditorProvider.ts veriflow-vscode/media/parsers veriflow-vscode/THIRD_PARTY_NOTICES.md veriflow-vscode/src/test/parserAssets.test.ts
git commit -m "build: add SystemVerilog parser assets"
```

### Task 2: Normalized Models And Position Mapping

**Files:**
- Create: `veriflow-vscode/src/core/hdl/model.ts`
- Create: `veriflow-vscode/src/core/hdl/positionMap.ts`
- Create: `veriflow-vscode/src/test/hdlPositionMap.test.ts`

- [ ] **Step 1: Write failing UTF-8/UTF-16 mapping tests**

```typescript
import * as assert from 'assert';
import { PositionMap } from '../core/hdl/positionMap';

const text = 'module top; // chinese: \u4fe1\u53f7\nendmodule\n';
const map = new PositionMap(text);
const endmoduleUtf16 = text.indexOf('endmodule');
const endmoduleByte = Buffer.byteLength(text.slice(0, endmoduleUtf16), 'utf8');

assert.strictEqual(map.byteToUtf16(endmoduleByte), endmoduleUtf16);
assert.strictEqual(map.utf16ToByte(endmoduleUtf16), endmoduleByte);
assert.deepStrictEqual(map.byteRangeToSourceRange(endmoduleByte, endmoduleByte + 9), {
  start: endmoduleUtf16,
  end: endmoduleUtf16 + 9,
});
const emojiText = 'a😀b';
const emojiMap = new PositionMap(emojiText);
assert.strictEqual(emojiMap.byteToUtf16(1), 1);
assert.strictEqual(emojiMap.byteToUtf16(5), 3);
assert.throws(() => emojiMap.byteToUtf16(2), /UTF-8 boundary/);
console.log('HDL position map tests passed');
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlPositionMap.test.js`

Expected: FAIL because `PositionMap` does not exist.

- [ ] **Step 3: Define stable serializable model contracts**

Create `model.ts` with these exact public types:

```typescript
export type SourceFileSpan = { uri: string; start: number; end: number };
export type SourceSpan = {
  start: number; end: number;
  uri?: string;
  compositeParts?: SourceFileSpan[];
};
export type WidthValue =
  | { kind: 'known'; bits: number }
  | { kind: 'symbolic'; expression: string }
  | { kind: 'unknown' };

export type HdlDiagnostic = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  span?: SourceSpan;
};

export type ParameterModel = {
  id: string;
  name: string;
  kind: 'parameter' | 'localparam';
  typeText: string;
  defaultExpression?: string;
  declarationSpan: SourceSpan;
  nameSpan: SourceSpan;
  valueSpan?: SourceSpan;
};

export type PortModel = {
  id: string;
  name: string;
  direction: 'input' | 'output' | 'inout';
  typeText: string;
  packedRange?: string;
  width: WidthValue;
  declarationSpan: SourceSpan;
  directionSpan?: SourceSpan;
  nameSpan: SourceSpan;
  headerItemSpan: SourceSpan;
  headerNameSpan: SourceSpan;
  bodyDeclarationSpan?: SourceSpan;
  bodyNameSpan?: SourceSpan;
  packedRangeSpan?: SourceSpan;
  declarationGroupId: string;
  inheritsDirection: boolean;
  inheritsType: boolean;
  inheritsPackedRange: boolean;
};
export type PortDeclarationGroupModel = {
  id: string; style: 'ansi' | 'non-ansi'; declarationSpan: SourceSpan;
  sharedPrefixSpan: SourceSpan;
  items: Array<{ portId: string; itemSpan: SourceSpan; separatorSpan?: SourceSpan }>;
};

export type ModuleModel = {
  id: string;
  name: string;
  nameSpan: SourceSpan;
  endLabel?: string;
  declarationStyle: 'ansi' | 'non-ansi';
  declarationSpan: SourceSpan;
  headerSpan: SourceSpan;
  bodySpan: SourceSpan;
  declarationRegionSpan: SourceSpan;
  endmoduleSpan: SourceSpan;
  parameters: ParameterModel[];
  localParameters: ParameterModel[];
  ports: PortModel[];
  portDeclarationGroups: PortDeclarationGroupModel[];
  instances: InstanceModel[];
  instanceDeclarationGroups: InstanceDeclarationGroupModel[];
};

export type InstanceConnectionModel = {
  name?: string;
  expression: string;
  expressionSpan: SourceSpan;
  connectionSpan: SourceSpan;
  nameSpan?: SourceSpan;
  syntax: 'named' | 'implicit' | 'positional' | 'wildcard';
};

export type InstanceModel = {
  id: string;
  moduleName: string;
  instanceName: string;
  syntax: 'named' | 'implicit' | 'positional' | 'wildcard' | 'mixed';
  declarationSpan: SourceSpan;
  declarationGroupId: string;
  itemSpan: SourceSpan;
  separatorSpan?: SourceSpan;
  moduleNameSpan: SourceSpan;
  nameSpan: SourceSpan;
  parameterConnections: InstanceConnectionModel[];
  portConnections: InstanceConnectionModel[];
};
export type InstanceDeclarationGroupModel = {
  id: string; statementSpan: SourceSpan; moduleNameSpan: SourceSpan;
  parameterBlockSpan?: SourceSpan;
  items: Array<{ instanceId: string; itemSpan: SourceSpan; separatorSpan?: SourceSpan }>;
};

export type NamedUnitModel = {
  id: string;
  kind: 'interface' | 'package';
  name: string;
  nameSpan: SourceSpan;
  declarationSpan: SourceSpan;
};

export type DirectiveModel = {
  kind: string;
  text: string;
  span: SourceSpan;
  active: boolean;
};

export type IncludeModel = {
  path: string;
  span: SourceSpan;
  resolvedUri?: string;
};

export type HdlDocument = {
  uri: string;
  languageId: 'verilog' | 'systemverilog';
  version: number;
  textHash: string;
  lineEnding: '\n' | '\r\n';
  preprocessingFingerprint: string;
  modules: ModuleModel[];
  interfaces: NamedUnitModel[];
  packages: NamedUnitModel[];
  directives: DirectiveModel[];
  includes: IncludeModel[];
  diagnostics: HdlDiagnostic[];
};
```

The adapter always sets `uri` for a contiguous model span. The optional form keeps existing pure offset fixtures concise; consumers interpret an omitted URI as `HdlDocument.uri`. A CST node whose text crosses source-file boundaries carries ordered `compositeParts`; source planners must treat that structure as read-only unless a later planner explicitly supports a multi-file edit.

- [ ] **Step 4: Implement PositionMap and pass the test**

```typescript
import { SourceSpan } from './model';

export class PositionMap {
  private readonly utf16ToByteOffsets: number[];
  private readonly byteBoundaryToUtf16 = new Map<number, number>();

  constructor(private readonly text: string) {
    this.utf16ToByteOffsets = new Array(text.length + 1);
    let byteOffset = 0;
    for (let offset = 0; offset < text.length;) {
      this.utf16ToByteOffsets[offset] = byteOffset;
      this.byteBoundaryToUtf16.set(byteOffset, offset);
      const codePoint = text.codePointAt(offset)!;
      const char = String.fromCodePoint(codePoint);
      const units = char.length;
      for (let i = 1; i < units; i++) this.utf16ToByteOffsets[offset + i] = byteOffset;
      byteOffset += Buffer.byteLength(char, 'utf8');
      offset += units;
    }
    this.utf16ToByteOffsets[text.length] = byteOffset;
    this.byteBoundaryToUtf16.set(byteOffset, text.length);
  }

  utf16ToByte(offset: number): number {
    if (offset < 0 || offset > this.text.length) throw new RangeError('UTF-16 offset out of range');
    return this.utf16ToByteOffsets[offset];
  }

  byteToUtf16(byteOffset: number): number {
    const offset = this.byteBoundaryToUtf16.get(byteOffset);
    if (offset === undefined) throw new RangeError('byte offset is not a UTF-8 boundary');
    return offset;
  }

  byteRangeToSourceRange(start: number, end: number): SourceSpan {
    return { start: this.byteToUtf16(start), end: this.byteToUtf16(end) };
  }
}
```

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlPositionMap.test.js`

Expected: `HDL position map tests passed`.

- [ ] **Step 5: Commit the model contracts**

```bash
git add veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/positionMap.ts veriflow-vscode/src/test/hdlPositionMap.test.ts
git commit -m "feat: define normalized HDL models"
```

### Task 3: Worker Protocol And Tree-sitter Initialization

**Files:**
- Create: `veriflow-vscode/src/core/hdl/protocol.ts`
- Create: `veriflow-vscode/src/core/hdl/parserQueue.ts`
- Create: `veriflow-vscode/src/core/hdl/parserWorker.ts`
- Create: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`
- Create: `veriflow-vscode/src/test/hdlWorker.test.ts`

- [ ] **Step 1: Write a failing real-WASM worker test**

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { Worker } from 'worker_threads';

const root = path.resolve(__dirname, '..', '..');
const worker = new Worker(path.join(root, 'dist', 'workers', 'hdlParserWorker.js'), {
  workerData: {
    runtimeWasmPath: path.join(root, 'media', 'parsers', 'web-tree-sitter.wasm'),
    languageWasmPath: path.join(root, 'media', 'parsers', 'tree-sitter-systemverilog.wasm'),
  },
});

worker.postMessage({
  type: 'parse', requestId: '1', uri: 'memory:/top.sv', version: 1,
  text: 'module top(input logic clk); endmodule', priority: 'interactive',
});

const response: any = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
assert.strictEqual(response.type, 'parsed');
assert.strictEqual(response.document.modules[0].name, 'top');
await worker.terminate();
console.log('HDL worker tests passed');
```

- [ ] **Step 2: Run the test and confirm the worker is missing**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlWorker.test.js`

Expected: FAIL because the worker entry point or parse adapter does not exist.

- [ ] **Step 3: Add discriminated protocol messages**

```typescript
import { HdlDocument } from './model';

export type ParseRequest = {
  type: 'parse'; requestId: string; uri: string; version: number; text: string;
  priority: 'interactive' | 'background';
};
export type CancelRequest = { type: 'cancel'; requestId: string };
export type DisposeRequest = { type: 'dispose' };
export type ParserWorkerRequest = ParseRequest | CancelRequest | DisposeRequest;

export type ParsedResponse = { type: 'parsed'; requestId: string; document: HdlDocument };
export type FailedResponse = { type: 'failed'; requestId: string; message: string };
export type ParserWorkerResponse = ParsedResponse | FailedResponse;
```

Create `parserQueue.ts` with the exact scheduling surface below. FIFO order is stable within each priority, a queued cancelled request is never returned, and an already-running parse is allowed to finish because Tree-sitter parsing is synchronous:

```typescript
export type ParsePriority = 'interactive' | 'background';
export class ParserRequestQueue<T extends { requestId: string; priority: ParsePriority }> {
  enqueue(request: T): void;
  cancel(requestId: string): boolean;
  takeNext(): T | undefined;
  clear(): T[];
  get size(): number;
}
```

Extend `hdlWorker.test.ts` with a pure queue test: enqueue background `b1`, background `b2`, interactive `i1`, cancel `b2`, and assert `takeNext()` returns `i1`, then `b1`, then `undefined`. This proves the scheduler independently of parser timing.

- [ ] **Step 4: Implement lazy WASM loading and minimal module extraction**

Implement `treeSitterAdapter.ts` with a real root traversal that recognizes `module_declaration`, reads its named header child, locates the `name` field, and converts every byte range through `PositionMap`. Attach the request URI to every contiguous `SourceSpan`; Task 5 replaces this single-file attachment with `CompositeSourceMap`. Return empty parameter, port, and instance lists in this task, plus Tree-sitter ERROR diagnostics.

Implement `parserWorker.ts` so it:

```typescript
import { parentPort, workerData } from 'worker_threads';
import { Language, Parser } from 'web-tree-sitter';
import { ParseRequest, ParserWorkerRequest, ParserWorkerResponse } from './protocol';
import { ParserRequestQueue } from './parserQueue';
import { adaptTree } from './treeSitterAdapter';

if (!parentPort) throw new Error('HDL parser worker requires a parent port');

let parserPromise: Promise<Parser> | undefined;
const queue = new ParserRequestQueue<ParseRequest>();
const cancelled = new Set<string>();
let running = false;
let runningRequestId: string | undefined;
let disposed = false;

async function getParser(): Promise<Parser> {
  if (!parserPromise) parserPromise = (async () => {
    await Parser.init({ locateFile: () => workerData.runtimeWasmPath });
    const language = await Language.load(workerData.languageWasmPath);
    if (language.abiVersion !== 15) throw new Error(`Unexpected SystemVerilog ABI ${language.abiVersion}`);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

async function pump(): Promise<void> {
  if (running || disposed) return;
  const request = queue.takeNext();
  if (!request) return;
  running = true;
  runningRequestId = request.requestId;
  try {
    const parser = await getParser();
    const tree = parser.parse(request.text);
    if (!tree) throw new Error('SystemVerilog parser returned no syntax tree');
    const document = adaptTree(request.uri, request.version, request.text, tree);
    tree.delete();
    if (!cancelled.delete(request.requestId)) {
      parentPort!.postMessage({ type: 'parsed', requestId: request.requestId, document } satisfies ParserWorkerResponse);
    }
  } catch (error) {
    if (!cancelled.delete(request.requestId)) {
      parentPort!.postMessage({ type: 'failed', requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies ParserWorkerResponse);
    }
  } finally {
    running = false;
    runningRequestId = undefined;
    void pump();
  }
}

parentPort.on('message', (request: ParserWorkerRequest) => {
  if (request.type === 'cancel') {
    if (!queue.cancel(request.requestId) && runningRequestId === request.requestId) cancelled.add(request.requestId);
    return;
  }
  if (request.type === 'dispose') { disposed = true; queue.clear(); return; }
  queue.enqueue(request);
  void pump();
});
```

Task 6 replaces the minimal parse body with preprocessing, retained trees, and disposal cleanup without changing this queue contract. Interactive requests are always selected before queued workspace-index requests.

- [ ] **Step 5: Run and commit the worker slice**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlWorker.test.js`

Expected: `HDL worker tests passed`.

```bash
git add veriflow-vscode/src/core/hdl/protocol.ts veriflow-vscode/src/core/hdl/parserQueue.ts veriflow-vscode/src/core/hdl/parserWorker.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/test/hdlWorker.test.ts
git commit -m "feat: parse SystemVerilog in a worker"
```

### Task 4: Parameters, Ports, Instances, And Source Spans

**Files:**
- Modify: `veriflow-vscode/src/core/hdl/model.ts`
- Modify: `veriflow-vscode/src/core/hdl/treeSitterAdapter.ts`
- Create: `veriflow-vscode/src/test/fixtures/hdl/structural.sv`
- Create: `veriflow-vscode/src/test/helpers/hdlWorkerFixture.ts`
- Create: `veriflow-vscode/src/test/helpers/fixturePath.ts`
- Create: `veriflow-vscode/src/test/hdlAdapter.test.ts`

- [ ] **Step 1: Add a structural golden fixture**

```systemverilog
module child #(
    parameter WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] data_i,
    output logic [WIDTH-1:0] data_o
);
endmodule

module top(input logic clk, input logic [7:0] source, output logic [7:0] sink);
    wire [7:0] linked;
    child #(.WIDTH(8)) u_child (
        .clk,
        .data_i(source),
        .data_o(linked)
    );
    child u_pair_a (.clk(clk)), u_pair_b (.clk(clk));
    assign sink = linked;
endmodule

module legacy(clk, data_o);
    input clk;
    output [3:0] data_o;
endmodule

interface bus_if(input logic clk);
    logic data;
endinterface

package widths_pkg;
    localparam int DEFAULT_WIDTH = 8;
endpackage
```

- [ ] **Step 2: Write exact adapter assertions and verify failure**

Create `src/test/helpers/hdlWorkerFixture.ts`:

```typescript
import * as path from 'path';
import { Worker } from 'worker_threads';
import { HdlDocument } from '../../core/hdl/model';

export async function parseWithRealWorker(uri: string, text: string): Promise<HdlDocument> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const worker = new Worker(path.join(root, 'dist', 'workers', 'hdlParserWorker.js'), {
    workerData: {
      runtimeWasmPath: path.join(root, 'media', 'parsers', 'web-tree-sitter.wasm'),
      languageWasmPath: path.join(root, 'media', 'parsers', 'tree-sitter-systemverilog.wasm'),
    },
  });
  const response = await new Promise<any>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.postMessage({ type: 'parse', requestId: 'fixture', uri, version: 1, text, priority: 'interactive', options: { defines: {} } });
  });
  await worker.terminate();
  if (response.type !== 'parsed') throw new Error(response.message);
  return response.document as HdlDocument;
}
```

Create `src/test/helpers/fixturePath.ts`:

```typescript
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');
export function fixturePath(...segments: string[]): string {
  return path.join(extensionRoot, 'src', 'test', 'fixtures', ...segments);
}
```

`tsc` does not copy `.v`/`.sv` fixtures into `out`; all tests in later plans must use this helper to read source fixtures from `src/test/fixtures`.

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';
import { fixturePath } from './helpers/fixturePath';

const fixture = fixturePath('hdl', 'structural.sv');
const source = fs.readFileSync(fixture, 'utf8');
const document = await parseWithRealWorker(fixture, source);
assert.deepStrictEqual(document.modules.map(item => item.name), ['child', 'top', 'legacy']);
assert.deepStrictEqual(document.interfaces.map(item => item.name), ['bus_if']);
assert.deepStrictEqual(document.packages.map(item => item.name), ['widths_pkg']);
const child = document.modules[0];
assert.strictEqual(child.parameters[0].name, 'WIDTH');
assert.strictEqual(child.parameters[0].defaultExpression, '8');
assert.deepStrictEqual(child.ports.map(item => [item.name, item.direction]), [
  ['clk', 'input'], ['data_i', 'input'], ['data_o', 'output'],
]);
const instance = document.modules[1].instances[0];
assert.deepStrictEqual([instance.moduleName, instance.instanceName], ['child', 'u_child']);
assert.strictEqual(instance.parameterConnections[0].expression, '8');
assert.strictEqual(instance.portConnections[0].syntax, 'implicit');
for (const connection of [instance.parameterConnections[0], instance.portConnections[1], instance.portConnections[2]]) {
  assert.strictEqual(source.slice(connection.expressionSpan.start, connection.expressionSpan.end), connection.expression);
}
const pairGroup = document.modules[1].instanceDeclarationGroups.find(group => group.items.length === 2)!;
assert.deepStrictEqual(pairGroup.items.map(item => source.slice(item.itemSpan.start, item.itemSpan.end).split(/\s*\(/)[0]), [
  'u_pair_a', 'u_pair_b',
]);
assert.strictEqual(document.modules[2].declarationStyle, 'non-ansi');
assert.deepStrictEqual(document.modules[2].ports.map(item => [item.name, item.direction]), [
  ['clk', 'input'], ['data_o', 'output'],
]);
```

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlAdapter.test.js`

Expected: FAIL because the adapter currently emits empty structural lists.

- [ ] **Step 3: Extend the model for declarations and expressions**

Add these exact structural contracts and corresponding arrays on `ModuleModel`:

```typescript
export type ExpressionModel = {
  kind: 'identifier' | 'select' | 'constant' | 'concat' | 'operation' | 'unknown';
  text: string;
  span: SourceSpan;
  width: WidthValue;
};
export type NetDeclarationModel = {
  id: string; kind: 'wire' | 'logic' | 'reg' | 'other'; typeText: string;
  names: Array<{ name: string; nameSpan: SourceSpan }>;
  declarationSpan: SourceSpan; packedRange?: string; width: WidthValue;
};
export type ContinuousAssignModel = {
  id: string; target: ExpressionModel; value: ExpressionModel; declarationSpan: SourceSpan;
};
export type SymbolReferenceModel = {
  name: string; span: SourceSpan; symbolId?: string;
  context: 'declaration' | 'connection' | 'assignmentTarget' | 'assignmentValue' | 'unknown';
};
export type ModuleSymbolModel = {
  id: string; name: string;
  kind: 'parameter' | 'port' | 'net' | 'variable' | 'instance';
  declarationSpans: SourceSpan[];
};
export type OpaqueLogicModel = {
  id: string; reason: string; span: SourceSpan; boundaryNames: string[];
};
```

Add `portDeclarationGroups`, `instanceDeclarationGroups`, `nets`, `continuousAssignments`, `symbols`, `references`, and `opaqueRegions` arrays to `ModuleModel`. Variables may initially use `NetDeclarationModel.kind = 'logic' | 'reg'`; generate/array metadata is added in semantic-hardening phase 6.

Add `defaultValue?: ExpressionModel` to `ParameterModel` and `expressionModel?: ExpressionModel` to `InstanceConnectionModel`. For implicit `.port`, `connectionSpan` covers the complete `.port`, while `expressionSpan` covers the implicit port identifier; for empty `.port()`, `expressionSpan` is the zero-length insertion point between parentheses. For ANSI inheritance such as `input logic [7:0] a, b` and grouped non-ANSI declarations, retain one declaration-group record plus per-item/separator spans and inheritance flags. A port has no individual `directionSpan`/`packedRangeSpan` when it inherits shared syntax; the source planner must split that declaration group before changing only that member.

- [ ] **Step 4: Implement CST field-based extraction**

In `treeSitterAdapter.ts`, add focused functions:

```typescript
function adaptParameter(node: Node, source: string, map: PositionMap): ParameterModel;
function adaptAnsiPort(node: Node, source: string, map: PositionMap): PortModel[];
function adaptNonAnsiPorts(moduleNode: Node, source: string, map: PositionMap): PortModel[];
function adaptInstance(node: Node, source: string, map: PositionMap): InstanceModel[];
function adaptExpression(node: Node, source: string, map: PositionMap): ExpressionModel;
function adaptNamedUnit(node: Node, kind: 'interface' | 'package', source: string, map: PositionMap): NamedUnitModel;
function adaptDirective(node: Node, source: string, map: PositionMap): DirectiveModel;
```

Use `childForFieldName()` when the grammar provides a field and explicit child-type switches otherwise. Extract module/interface/package declarations, active directives/includes, module-scope nets/variables, continuous assignments, instances, and symbol-reference spans. Build a module-scope symbol table first, then resolve simple identifier references in continuous assignments and instance connection expressions to exact symbol IDs. References shadowed by a procedural/local declaration or hidden behind a macro remain unresolved with `symbolId` absent; later rename logic touches only references carrying the selected symbol ID. Never locate a semantic value with a source regex. Preserve source order and raw expression text; opaque procedural regions expose only referenced module-scope boundary names.

- [ ] **Step 5: Run focused and full tests, then commit**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlAdapter.test.js`

Expected: all structural assertions pass.

Run: `cd veriflow-vscode && npm test`

Expected: existing core and waveform tests still pass.

```bash
git add veriflow-vscode/src/core/hdl/model.ts veriflow-vscode/src/core/hdl/treeSitterAdapter.ts veriflow-vscode/src/test/fixtures/hdl/structural.sv veriflow-vscode/src/test/helpers/fixturePath.ts veriflow-vscode/src/test/helpers/hdlWorkerFixture.ts veriflow-vscode/src/test/hdlAdapter.test.ts veriflow-vscode/package.json
git commit -m "feat: extract normalized HDL structure"
```

### Task 5: Active-Branch Preprocessing With Source Mapping

**Files:**
- Create: `veriflow-vscode/src/core/hdl/preprocessor.ts`
- Modify: `veriflow-vscode/src/core/hdl/protocol.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserWorker.ts`
- Create: `veriflow-vscode/src/test/hdlPreprocessor.test.ts`

- [ ] **Step 1: Write failing active-branch tests**

```typescript
import * as assert from 'assert';
import { preprocessForParsing } from '../core/hdl/preprocessor';
import { PositionMap } from '../core/hdl/positionMap';

const source = [
  '`define LOCAL',
  '`ifdef OUTER',
  'module inactive; endmodule',
  '`elsif LOCAL',
  'module active; child u_child(); endmodule',
  '`else',
  'module fallback; endmodule',
  '`endif',
  '`undef LOCAL',
].join('\r\n');
const result = preprocessForParsing('file:///workspace/top.sv', source, { defines: {} });
assert.strictEqual(result.text.length, source.length);
for (let i = 0; i < source.length; i++) {
  if (source[i] === '\r' || source[i] === '\n') assert.strictEqual(result.text[i], source[i]);
}
assert.ok(result.text.includes('module active; child u_child(); endmodule'));
assert.ok(!result.text.includes('module inactive'));
assert.ok(!result.text.includes('module fallback'));
assert.strictEqual(result.activeDefines.LOCAL, undefined);

const includeResult = preprocessForParsing('file:///workspace/top.sv', [
  '`include "defs.svh"',
  '`ifdef FROM_INCLUDE',
  'module included_branch; endmodule',
  '`endif',
].join('\n'), {
  defines: {}, resolvedIncludes: [{
    fromUri: 'file:///workspace/top.sv', rawPath: 'defs.svh',
    resolvedUri: 'file:///workspace/include/defs.svh', text: '`define FROM_INCLUDE 1\n',
  }],
});
assert.ok(includeResult.text.includes('module included_branch'));

const portInclude = preprocessForParsing(
  'file:///workspace/with_ports.sv',
  'module with_ports (\n`include "ports.svh"\n);\n`include "body.svh"\nendmodule\n',
  { defines: {}, resolvedIncludes: [
    { fromUri: 'file:///workspace/with_ports.sv', rawPath: 'ports.svh', resolvedUri: 'file:///workspace/ports.svh', text: 'input logic clk, output logic done' },
    { fromUri: 'file:///workspace/with_ports.sv', rawPath: 'body.svh', resolvedUri: 'file:///workspace/body.svh', text: 'child u_child(.clk(clk), .done(done));' },
  ] },
);
assert.ok(portInclude.text.includes('input logic clk, output logic done'));
assert.ok(portInclude.text.includes('child u_child'));
const includedPortOffset = portInclude.text.indexOf('clk');
assert.deepStrictEqual(portInclude.sourceMap.mapSpan(includedPortOffset, includedPortOffset + 3), {
  start: 12, end: 15, uri: 'file:///workspace/ports.svh',
});

const unicodeSource = '`ifdef OFF\n// 信号 😀\n`endif\nmodule after_unicode; endmodule\n';
const unicodeResult = preprocessForParsing('file:///workspace/unicode.sv', unicodeSource, { defines: {} });
const transformedMap = new PositionMap(unicodeResult.text);
const originalOffset = unicodeSource.indexOf('module after_unicode');
const transformedByte = Buffer.byteLength(unicodeResult.text.slice(0, originalOffset), 'utf8');
assert.strictEqual(transformedMap.byteToUtf16(transformedByte), originalOffset);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlPreprocessor.test.js`

Expected: FAIL because `preprocessForParsing` is missing.

- [ ] **Step 3: Implement a source-mapped composite preprocessor**

Expose:

```typescript
export type ResolvedIncludeInput = {
  fromUri: string; rawPath: string; resolvedUri: string; text: string;
};
export type PreprocessOptions = {
  defines: Record<string, string | true>;
  resolvedIncludes?: ResolvedIncludeInput[];
  maxIncludeDepth?: number;
};
export type CompositeSourceSegment = {
  generatedStart: number; generatedEnd: number;
  sourceUri: string; sourceStart: number; sourceEnd: number;
};
export class CompositeSourceMap {
  constructor(readonly segments: readonly CompositeSourceSegment[]);
  mapOffset(generatedOffset: number, bias: 'start' | 'end'): SourceFileSpan;
  mapSpan(generatedStart: number, generatedEnd: number): SourceSpan;
}
export type PreprocessResult = {
  text: string;
  sourceMap: CompositeSourceMap;
  sourceTexts: Readonly<Record<string, string>>;
  activeDefines: Record<string, string | true>;
  diagnostics: HdlDiagnostic[];
};
export function preprocessForParsing(sourceUri: string, source: string, options: PreprocessOptions): PreprocessResult;
```

Track nested frames `{ parentActive, branchActive, branchTaken }`. In each individual source file, replace inactive non-newline characters and non-include directive text with spaces so locations inside that file remain stable. Resolve an active include by the exact `(current source URI, raw include path)` pair, replace the include directive text with the recursively preprocessed included content, and append source-map segments for every emitted slice. This is textual SystemVerilog include semantics: an included port-list fragment or module-body fragment must participate in the parent's CST rather than disappearing. The composite generated stream may have a different length from the primary source.

`CompositeSourceMap.mapSpan` maps a span wholly inside one origin to `{ uri, start, end }`; when a CST node crosses origin files, it returns a primary `start/end` plus ordered `compositeParts`. The adapter uses `PositionMap` to convert Tree-sitter UTF-8 bytes to composite UTF-16 offsets, then `CompositeSourceMap` to map those offsets back to original file URIs and UTF-16 spans. Atomic tokens, names, expressions, and connection values must map to one file. Cross-file declaration/group spans remain visible but carry `compositeParts` and are read-only for source generation. Preserve all source texts so model text is sliced from the owning source when contiguous.

Included `define`/`undef` side effects take effect at the include position, while included structural text remains in the composite stream. Keep declarations whose name span belongs to an included file in the normalized document, but `WorkspaceHdlIndex` later indexes a definition only from the document whose URI owns that definition name; this avoids duplicate index entries when a header containing a complete module is included elsewhere. Detect canonical-URI include cycles and a default depth limit of 32. Do not expand function-like macros in this task; keep macro invocations parseable and emit `HDL_MACRO_UNEXPANDED` warnings when they affect structural positions.

- [ ] **Step 4: Pass defines through the worker protocol**

Add `options: HdlParseOptions` to `ParseRequest`, where `HdlParseOptions = PreprocessOptions & { cacheMode?: 'document' | 'ephemeral' }`. Parse `PreprocessResult.text` and construct `PositionMap` from that composite transformed text: Tree-sitter byte offsets belong to the composite UTF-8 stream. Convert transformed bytes to composite UTF-16 with `PositionMap`, then map through `CompositeSourceMap`; never apply a composite byte offset directly to the primary source. Merge preprocessing diagnostics into `HdlDocument.diagnostics` and record a stable hash of defines, the canonical include graph, and include contents in `preprocessingFingerprint`.

Extend `hdlPreprocessor.test.ts` through `parseWithRealWorker` with two regressions: a header included inside a module port list produces real `PortModel` entries whose name spans point to the header URI, and a header included in a module body produces a real child `InstanceModel`. Also assert a cross-origin declaration span has `compositeParts` and is not accepted by a source-edit planner.

- [ ] **Step 5: Verify and commit**

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlPreprocessor.test.js && node ./out/test/hdlAdapter.test.js`

Expected: both test files pass.

```bash
git add veriflow-vscode/src/core/hdl/preprocessor.ts veriflow-vscode/src/core/hdl/protocol.ts veriflow-vscode/src/core/hdl/parserWorker.ts veriflow-vscode/src/test/hdlPreprocessor.test.ts
git commit -m "feat: preprocess active HDL branches"
```

### Task 6: Parser Client, Cancellation, And Version Cache

**Files:**
- Create: `veriflow-vscode/src/core/hdl/parserClient.ts`
- Create: `veriflow-vscode/src/core/hdl/treeEdit.ts`
- Modify: `veriflow-vscode/src/core/hdl/protocol.ts`
- Modify: `veriflow-vscode/src/core/hdl/parserWorker.ts`
- Create: `veriflow-vscode/src/test/hdlParserClient.test.ts`

- [ ] **Step 1: Write client lifecycle tests with a fake worker**

Use an injected `WorkerLike` with `postMessage`, `on`, and `terminate`. Assert:

- duplicate `(uri, version, text hash, preprocessing fingerprint, cache mode)` requests share one promise;
- the same URI/version with different text never reuses a cached promise;
- a newer version sends `cancel` for the old request;
- a newer version of the same URI sends a new parse request but no client-computed `TreeEdit`;
- interactive calls set `priority: 'interactive'`, while an explicit background call sets `priority: 'background'`;
- `computeTreeEdit` after CRLF plus an astral character reports UTF-8 byte indices and zero-based byte columns exactly as `Buffer.byteLength` computes them;
- stale responses do not replace the cache;
- `dispose()` terminates the worker and rejects pending requests.

Add real-worker incremental-versus-full equivalence cases. For each case, parse version 1 in document mode, parse version 2 in document mode so the worker reuses its retained tree, parse the same version-2 input in ephemeral mode for a full parse, and deep-compare normalized modules/ports/instances/diagnostics after removing request/version metadata:

- a local `` `define`` edit flips a distant `` `ifdef`` branch;
- an inactive branch containing Chinese text and an astral character changes near its start;
- changing an included header's `` `define`` flips a branch in the parent file;
- changing included port-list and module-body fragments changes the resulting parent structure.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlParserClient.test.js`

Expected: FAIL because `HdlParserClient` is missing.

- [ ] **Step 3: Implement the client with injectable worker creation**

```typescript
export type HdlParserClientOptions = {
  workerPath: string;
  runtimeWasmPath: string;
  languageWasmPath: string;
  createWorker?: (path: string, workerData: Record<string, string>) => WorkerLike;
};

export type ParserTreeEdit = {
  startIndex: number; oldEndIndex: number; newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
};

export function computeTreeEdit(oldText: string, newText: string): ParserTreeEdit | undefined;

export class HdlParserClient {
  parse(
    uri: string,
    version: number,
    text: string,
    options: HdlParseOptions,
    priority?: ParsePriority,
  ): Promise<HdlDocument>;
  invalidate(uri: string): void;
  clearCache(): void;
  dispose(): Promise<void>;
}
```

Key the cache by URI and store `{ version, preprocessingFingerprint, textHash, cacheMode, text, promise }`; reuse requires every field to match. The fingerprint includes define values, the canonical include graph, and include-content hashes. The client never computes or serializes a `ParserTreeEdit`, because the retained tree represents preprocessed composite text rather than the primary raw source. `cacheMode: 'ephemeral'` bypasses the document cache and is mandatory for candidate/fragment parsing. Default priority is `interactive`; `WorkspaceHdlIndex` is the explicit `background` caller. Use monotonically increasing request IDs and one pending map. `clearCache()` cancels pending requests and drops every cached document without eagerly creating a worker. On worker failure, reject all pending work and allow the next `parse` call to create a replacement worker.

In `parserWorker.ts`, preprocess every request first and retain an LRU of at most eight `{ uri, version, preprocessingFingerprint, textHash, preprocessedText, sourceMap, tree }` document-mode entries. For the latest retained tree of the same URI, call `computeTreeEdit(old.preprocessedText, nextPreprocessed.text)` in the worker. The helper finds a longest common prefix/suffix only at Unicode code-point boundaries and returns UTF-8 byte indices plus zero-based UTF-8 byte columns for `web-tree-sitter` 0.26.11. Validate the result, construct `const edit = new Edit(treeEdit)`, call `old.tree.edit(edit)`, and parse `nextPreprocessed.text` with that edited tree. A changed directive, branch, include graph, or include content is therefore represented by the complete transformed-text difference, not a misleading raw-source edit. If no retained entry or no safe edit exists, parse without an old tree.

Check every `parser.parse` result for `null` before adapting or deleting it. Adapt with the new composite source map. Ephemeral requests never read or replace the LRU. Delete replaced/evicted trees explicitly. A queued cancelled request never starts. A cancel message cannot preempt a synchronous Tree-sitter call already occupying the worker event loop, so that call may publish and temporarily populate the LRU; the client rejects stale responses by request generation, and the newer queued request safely edits from that retained preprocessed tree. `dispose` clears the queue after the running call yields, deletes all retained trees and parser/language resources, then closes the worker. Raw trees and source maps never leave the worker.

- [ ] **Step 4: Verify real worker integration**

Add one real-worker assertion using the compiled worker and parser assets after fake-worker unit tests pass.

Run: `cd veriflow-vscode && npm run compile && node ./out/test/hdlParserClient.test.js`

Expected: fake and real worker assertions pass.

- [ ] **Step 5: Commit the client**

```bash
git add veriflow-vscode/src/core/hdl/parserClient.ts veriflow-vscode/src/core/hdl/treeEdit.ts veriflow-vscode/src/core/hdl/protocol.ts veriflow-vscode/src/core/hdl/parserWorker.ts veriflow-vscode/src/test/hdlParserClient.test.ts
git commit -m "feat: add HDL parser client cache"
```

### Task 7: Extension Configuration And Lifecycle

**Files:**
- Create: `veriflow-vscode/src/core/hdl/index.ts`
- Modify: `veriflow-vscode/src/core/index.ts`
- Modify: `veriflow-vscode/src/config.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/package.json`
- Create: `veriflow-vscode/src/test/hdlConfig.test.ts`

- [ ] **Step 1: Write failing configuration assertions**

Read `package.json` and assert `veriflow.defines` is an object with string-or-boolean additional properties and default `{}`. Assert `getSettings()` returns a `defines` object.

- [ ] **Step 2: Run and verify failure**

Run: `cd veriflow-vscode && npm run compile:ts && node ./out/test/hdlConfig.test.js`

Expected: FAIL because `veriflow.defines` is absent.

- [ ] **Step 3: Add settings and public exports**

Add this contribution:

```json
"veriflow.defines": {
  "type": "object",
  "default": {},
  "additionalProperties": { "type": ["string", "boolean"] },
  "description": "SystemVerilog preprocessor defines used by VeriFlow structural parsing"
}
```

Export `HdlParserClient`, all normalized model types, and a `createHdlParserClient(context)` factory from `core/hdl/index.ts`.

- [ ] **Step 4: Own one lazy client in extension lifecycle**

Create a module-level `let hdlParser: HdlParserClient | undefined`. Instantiate it only inside `getHdlParser(context)`. Dispose it from `deactivate()`. Configuration changes call `hdlParser?.clearCache()` but do not eagerly start the worker. Do not migrate existing consumers in this task.

- [ ] **Step 5: Run full verification and commit**

Run: `cd veriflow-vscode && npm test`

Expected: every existing test plus parser asset, position, worker, adapter, preprocessor, client, and config tests passes.

Run: `cd veriflow-vscode && npm run package`

Expected: VSCE succeeds; the package contains two parser WASM files and no `tree-sitter-systemverilog` source or native prebuild directory.

```bash
git add veriflow-vscode/src/core/hdl/index.ts veriflow-vscode/src/core/index.ts veriflow-vscode/src/config.ts veriflow-vscode/src/extension.ts veriflow-vscode/package.json veriflow-vscode/package-lock.json veriflow-vscode/src/test/hdlConfig.test.ts
git commit -m "feat: register lazy HDL parser service"
```

## Plan Completion Gate

Run these commands from `veriflow-vscode`:

```bash
npm test
npm run lint
npm run package
```

Expected results:

- all tests report zero failures;
- ESLint reports zero errors;
- VSCE produces a package with only the required parser WASM assets;
- opening the extension without an HDL action does not create the parser worker;
- a direct parser-client test parses ANSI SystemVerilog with no CST error;
- `git status --short` contains no generated asset or package residue intended to remain untracked.

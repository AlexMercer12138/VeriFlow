# Unified Webview Frontends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate schematic, VS Code Testbench Generator, and waveform browser surfaces to TypeScript, the shared esbuild path, a shared typed host runtime, and deterministic browser previews while preserving rendering and user-visible behavior.

**Architecture:** `@veriflow/webview-runtime` selects one typed VS Code, Qt WebChannel, or in-memory transport from an explicit JSON bootstrap element and owns persisted state, subscriptions, and disposal. Each application owns its protocol and rendering logic, builds an unminified IIFE into canonical `web-dist`, and has deterministic browser fixtures. Host providers inject only CSP/resource URIs/bootstrap JSON; they no longer inline or rewrite generated JavaScript.

**Tech Stack:** TypeScript, esbuild, DOM, Canvas 2D, AntV X6/SVG, Dagre, Qt WebChannel, VS Code Webviews, Playwright, Node static preview server, existing Python QtWebEngine smoke harness.

---

## File Structure

```text
packages/webview-runtime/src/
  bootstrap.ts                 validated JSON bootstrap contract
  transport.ts                 typed transport interface and factory
  adapters/vscode.ts           VS Code API/state/message adapter
  adapters/qt.ts               QWebChannel async adapter and send queue
  adapters/memory.ts           browser fixture adapter
  theme.css                    shared minimal tokens and reset

packages/schematic-webview/src/
  protocol.ts                  schematic host/web message types
  model.ts                     graph and layout serializable types
  app.ts                       lifecycle and orchestration
  graphView.ts                 X6 shape/render/viewport behavior
  search.ts                    search state and navigation
  index.ts                     bootstrap only

packages/testbench-webview/src/
  protocol.ts                  testbench host/web message types
  state.ts                     editor state and validation
  app.ts                       DOM binding and message handling
  index.ts                     bootstrap only

packages/waveform-webview/src/
  protocol.ts                  indexed waveform host/web messages
  model.ts                     UI and persisted state types
  core/                        codecs, cache, retry, frame scheduler
  data/                        metadata/window/value/search state
  viewport/                    time range, layout, resize, selection
  render/                      Canvas renderer and labels
  interaction/                 pointer, keyboard, drag, context menu
  app.ts                       orchestration and test inspection API
  index.ts                     bootstrap only

scripts/preview-web.mjs        local deterministic preview server
tests/webview/*.spec.ts        browser interactions and visual assertions
tests/webview/snapshots/       reviewed screenshot baselines
fixtures/{schematic,testbench,waveform}/
```

Host-side graph building, VCD indexing, Testbench generation, file access, and VS Code/Qt lifecycle remain outside Webview packages.

### Task 1: Implement the shared typed Webview runtime

**Files:**
- Create: `packages/webview-runtime/package.json`
- Create: `packages/webview-runtime/tsconfig.json`
- Create: `packages/webview-runtime/tsconfig.test.json`
- Create: `packages/webview-runtime/src/bootstrap.ts`
- Create: `packages/webview-runtime/src/transport.ts`
- Create: `packages/webview-runtime/src/adapters/vscode.ts`
- Create: `packages/webview-runtime/src/adapters/qt.ts`
- Create: `packages/webview-runtime/src/adapters/memory.ts`
- Create: `packages/webview-runtime/src/index.ts`
- Create: `packages/webview-runtime/src/theme.css`
- Create: `packages/webview-runtime/test/transport.test.ts`

- [ ] **Step 1: Write failing memory and queued-Qt transport tests**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostTransport } from '../src';

test('memory transport carries typed messages and state', () => {
    const received: Array<{ type: string }> = [];
    const environment = memoryEnvironment(message => received.push(message));
    const transport = createHostTransport<{ type: 'host' }, { type: 'web' }, { count: number }>({
        host: 'memory',
        app: 'schematic',
    }, environment);
    transport.send({ type: 'web' });
    transport.setState({ count: 2 });
    assert.deepStrictEqual(received, [{ type: 'web' }]);
    assert.deepStrictEqual(transport.getState(), { count: 2 });
});

test('Qt transport queues sends until QWebChannel is ready', async () => {
    const fixture = qtEnvironmentFixture();
    const transport = createHostTransport({ host: 'qt', app: 'waveform' }, fixture.environment);
    transport.send({ type: 'ready' });
    assert.deepStrictEqual(fixture.sent, []);
    fixture.connect();
    await fixture.ready;
    assert.deepStrictEqual(fixture.sent, ['{"type":"ready"}']);
});
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run: `npm test --workspace @veriflow/webview-runtime`

Expected: FAIL because the runtime package does not exist.

- [ ] **Step 3: Define and validate the bootstrap contract**

```typescript
export type WebviewApp = 'waveform' | 'schematic' | 'testbench';
export type HostKind = 'vscode' | 'qt' | 'memory';

export type BootstrapConfig = {
    version: 1;
    app: WebviewApp;
    host: HostKind;
    fixtureUrl?: string;
};

export function readBootstrap(document: Document): BootstrapConfig {
    const element = document.getElementById('veriflow-bootstrap');
    if (!(element instanceof HTMLScriptElement) || element.type !== 'application/json') {
        throw new Error('Missing VeriFlow bootstrap configuration');
    }
    const value = JSON.parse(element.textContent || 'null') as unknown;
    if (!isBootstrapConfig(value)) throw new Error('Invalid VeriFlow bootstrap configuration');
    return value;
}
```

Validation accepts only version 1, the three app names, the three host names, and an optional string fixture URL. Hosts JSON-escape `<`, `>`, `&`, U+2028, and U+2029 before insertion.

- [ ] **Step 4: Define the typed transport lifecycle**

```typescript
export interface HostTransport<Inbound, Outbound, State = unknown> {
    readonly kind: HostKind;
    readonly ready: Promise<void>;
    send(message: Outbound): void;
    subscribe(listener: (message: Inbound) => void): () => void;
    getState(): State | undefined;
    setState(state: State): void;
    dispose(): void;
}
```

The factory receives the validated bootstrap plus an injectable `Window`-like environment for tests. Applications never inspect globals directly.

- [ ] **Step 5: Implement all three adapters**

The VS Code adapter calls `acquireVsCodeApi()` exactly once, subscribes to `window.message`, and forwards state. The Qt adapter creates `QWebChannel`, uses `channel.objects.waveformBridge`, parses its `message` signal as JSON, calls `bridge.send(JSON.stringify(message))`, and flushes queued messages after ready. The memory adapter uses `window.__veriflowMemoryHost`, with no-op in-memory state when a fixture host is absent.

- [ ] **Step 6: Add minimal shared CSS tokens**

`theme.css` defines only box sizing, `color-scheme`, focus outline, font inheritance, and semantic tokens such as `--vf-bg`, `--vf-panel`, `--vf-text`, `--vf-muted`, `--vf-border`, `--vf-accent`, `--vf-danger`, and `--vf-warning`. Application layout and component appearance stay application-owned.

- [ ] **Step 7: Run runtime tests and commit**

Run: `npm test --workspace @veriflow/webview-runtime`

Expected: PASS for VS Code single acquisition, message unsubscribe, state, Qt queuing/invalid JSON, memory messages, bootstrap rejection, and idempotent disposal.

```bash
git add packages/webview-runtime package-lock.json
git commit -m "feat: add shared Webview runtime"
```

### Task 2: Add unified build descriptors and deterministic browser preview

**Files:**
- Modify: `scripts/build-web.mjs`
- Create: `scripts/preview-web.mjs`
- Create: `tests/webview/playwright.config.ts`
- Create: `tests/webview/preview.spec.ts`
- Create: `fixtures/runtime/basic.json`
- Modify: `package.json`

- [ ] **Step 1: Write a failing preview smoke test**

```typescript
import { expect, test } from '@playwright/test';

test('preview server exposes a memory-host runtime fixture', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/preview/runtime?fixture=basic');
    await expect(page.locator('[data-testid="runtime-shell"]')).toBeVisible();
    await expect(page.locator('[data-host-kind]')).toHaveAttribute('data-host-kind', 'memory');
    expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run the preview test to verify it fails**

Run: `npm run test:webview -- --grep "memory-host runtime fixture"`

Expected: FAIL because preview tooling and the runtime fixture page are absent.

- [ ] **Step 3: Make the current Web build descriptors explicit**

The foundation descriptors for waveform and schematic contain `name`, current
entry point/static source, output directory, and third-party license roots.
Each migration task converts its descriptor to a TypeScript entry. Task 5 adds
the Testbench descriptor only after that package exists. `build:web` uses
shared deterministic options and updates notices from every current esbuild
metafile; it never requires a not-yet-created application.

- [ ] **Step 4: Implement a bounded local preview server**

`npm run preview -- waveform` starts an HTTP server on `127.0.0.1`, accepts only `/preview/<app>`, `/assets/<app>/<file>`, and `/fixtures/<app>/<file>.json`, rejects `..` and decoded path escapes, injects memory bootstrap JSON into the HTML, and prints the selected URL. Port defaults to 4173 and accepts `--port`. A small `/preview/runtime` page built from `webview-runtime` uses the valid `schematic` app identifier and proves the server/bootstrap/memory adapter before product applications migrate.

- [ ] **Step 5: Add deterministic fixture envelopes**

The runtime fixture JSON has:

```json
{
  "fixtureVersion": 1,
  "app": "schematic",
  "messages": [],
  "expectedReadyType": "ready"
}
```

Product fixture files are added in their corresponding migration tasks: a
three-node/two-edge schematic in Task 4, two selectable Testbench modules in
Task 6, and a small indexed waveform in Task 9.

- [ ] **Step 6: Register Playwright commands**

Root scripts:

```json
{
  "preview": "node scripts/preview-web.mjs",
  "test:webview": "playwright test -c tests/webview/playwright.config.ts"
}
```

Add exact `@playwright/test` dependency and use Chromium. Configure the test server to run `node scripts/preview-web.mjs --all --port 4173` with `reuseExistingServer: true` locally and false in CI.

- [ ] **Step 7: Commit preview infrastructure after the runtime fixture passes**

Run: `npm run build:web`

Run: `npm run test:webview -- --grep "memory-host runtime fixture"`

Expected: the preview server path/security tests and runtime fixture pass.
There are no skipped product tests because each product test is introduced
only when its application migrates.

```bash
git add scripts/build-web.mjs scripts/preview-web.mjs tests/webview fixtures package.json package-lock.json web-dist
git commit -m "test: add unified Webview preview"
```

### Task 3: Move schematic serializable types into its application package

**Files:**
- Move: `veriflow-vscode/src/schematic/graphModel.ts` -> `packages/schematic-webview/src/model.ts`
- Move: `veriflow-vscode/src/schematic/protocol.ts` -> `packages/schematic-webview/src/protocol.ts`
- Split: `veriflow-vscode/src/schematic/layoutStore.ts`
- Create: `packages/schematic-webview/src/layout.ts`
- Create: `packages/schematic-webview/tsconfig.test.json`
- Modify: `packages/schematic-webview/package.json`
- Create: `packages/schematic-webview/test/protocol.test.ts`
- Modify: `veriflow-vscode/src/schematic/graphBuilder.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Modify: schematic tests and imports

- [ ] **Step 1: Write failing package protocol round-trip tests**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebviewCommand, type HostEvent } from '../src/protocol';

test('schematic protocol remains shared by host and Webview', () => {
    assert.deepStrictEqual(parseWebviewCommand({ type: 'ready' }), { type: 'ready' });
    const event: HostEvent = {
        type: 'diagnostics',
        errors: 0,
        warnings: 1,
        items: [],
    };
    assert.equal(event.type, 'diagnostics');
});
```

- [ ] **Step 2: Run package tests to verify they fail**

Run: `npm test --workspace @veriflow/schematic-webview`

Expected: FAIL because protocol/model code remains extension-owned.

- [ ] **Step 3: Move serializable graph and protocol types**

Use `git mv` for graph model and protocol. They may import `SourceSpan` and diagnostics from `@veriflow/hdl-core`, but cannot import `vscode` or extension modules. The extension graph builder and provider import these package exports.

- [ ] **Step 4: Split pure layout from VS Code persistence**

Move `SchematicLayout`, node sizing constants, route derivation, merge, relayout, and clone functions to package `layout.ts`. Keep `SchematicLayoutStore` and its Memento-like dependency in extension `layoutStore.ts`, importing the shared layout types/functions.

- [ ] **Step 5: Export shared schematic API and update all imports**

`packages/schematic-webview/src/public.ts` exports model, layout, and protocol. The package manifest exposes `./shared` for host imports while browser `index.ts` remains its bundle entry. No package source imports `../../../veriflow-vscode` after this task.
Add the package test script
`tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js`, using the
same `rootDir: "."` and `outDir: "dist-test"` convention as the HDL packages.

- [ ] **Step 6: Run package and host tests**

Run: `npm test --workspace @veriflow/schematic-webview`

Run: `npm test --workspace veriflow-vscode`

Expected: protocol, graph, layout, navigation, provider, and integration tests pass.

- [ ] **Step 7: Commit shared schematic types**

```bash
git add packages/schematic-webview veriflow-vscode/src/schematic veriflow-vscode/src/test package-lock.json
git commit -m "refactor: share schematic Webview models"
```

### Task 4: Migrate schematic bootstrap and application lifecycle to `webview-runtime`

**Files:**
- Create: `packages/schematic-webview/src/app.ts`
- Create: `packages/schematic-webview/src/graphView.ts`
- Create: `packages/schematic-webview/src/search.ts`
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.html`
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/schematic/schematicEditorProvider.ts`
- Create: `tests/webview/schematic.spec.ts`

- [ ] **Step 1: Write a failing transport isolation test**

Add to package tests:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

test('schematic browser source has no direct VS Code global', async () => {
    const sourceRoot = path.resolve(__dirname, '..', 'src');
    const source = fs.readdirSync(sourceRoot)
        .filter(name => name.endsWith('.ts'))
        .map(name => fs.readFileSync(path.join(sourceRoot, name), 'utf8'))
        .join('\n');
    assert.doesNotMatch(source, /acquireVsCodeApi|window\.addEventListener\(['"]message/);
    assert.match(source, /createHostTransport/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @veriflow/schematic-webview`

Expected: FAIL on direct `acquireVsCodeApi` and `window.message` usage.

- [ ] **Step 3: Split orchestration from X6 rendering without changing layout/routing**

`GraphView` owns X6 graph, shapes, selection, minimap, viewport, current graph/layout, and emits callbacks:

```typescript
export type GraphViewEvents = {
    onLayoutChanged(layout: SchematicLayout): void;
    onSelectionChanged(objectId: string | undefined): void;
    onRevealSource(objectId: string): void;
    onOpenDefinition(objectId: string): void;
};

export class GraphView {
    render(graph: SchematicGraph, layout: SchematicLayout): void;
    clear(message?: string): void;
    fit(): void;
    relayout(): void;
    dispose(): void;
}
```

Move existing functions without changing X6, Dagre, node dimensions, feedback routes, connector choices, or manual-layout persistence.

- [ ] **Step 4: Use the shared transport in `SchematicApp`**

`SchematicApp` subscribes to `HostEvent`, sends typed `WebviewCommand`, restores/saves `PersistedWebviewState`, debounces layouts, binds toolbar/search controls, sends `ready` only after `transport.ready`, and disposes graph/listeners/transport on pagehide.

`index.ts` is only:

```typescript
import { readBootstrap, createHostTransport } from '@veriflow/webview-runtime';
import { SchematicApp } from './app';

const bootstrap = readBootstrap(document);
const transport = createHostTransport(bootstrap, window);
const app = new SchematicApp(document, transport);
void app.start();
```

- [ ] **Step 5: Make host HTML inject resources and bootstrap only**

`buildSchematicWebviewHtml` inserts CSP, `index.css` URI, this escaped JSON element, and `index.js` URI:

```html
<script id="veriflow-bootstrap" type="application/json">{"version":1,"app":"schematic","host":"vscode"}</script>
```

It does not inline source or call application APIs.

- [ ] **Step 6: Add browser interaction and SVG assertions**

The Playwright test loads `basic`, waits for `ready`, asserts three `[data-cell-id]` nodes and two edge paths, selects a node, zooms, searches, toggles minimap, persists layout through the memory host, reloads, and checks zero console/page errors. Assert the SVG bounding box is non-zero and at least 1% of sampled pixels differ from the background.

- [ ] **Step 7: Run schematic host and visual tests**

Run: `npm run build:web && npm test --workspace @veriflow/schematic-webview && npm test --workspace veriflow-vscode`

Run: `npm run test:webview -- tests/webview/schematic.spec.ts`

Expected: PASS; remove the schematic preview skip and update the reviewed desktop snapshot.

- [ ] **Step 8: Commit schematic migration**

```bash
git add packages/schematic-webview veriflow-vscode/src/schematic tests/webview fixtures/schematic web-dist
git commit -m "refactor: migrate schematic to shared Webview runtime"
```

### Task 5: Extract the Testbench Generator Webview into TypeScript

**Files:**
- Create: `packages/testbench-webview/package.json`
- Create: `packages/testbench-webview/tsconfig.json`
- Create: `packages/testbench-webview/tsconfig.test.json`
- Create: `packages/testbench-webview/src/protocol.ts`
- Create: `packages/testbench-webview/src/state.ts`
- Create: `packages/testbench-webview/src/app.ts`
- Create: `packages/testbench-webview/src/index.ts`
- Create: `packages/testbench-webview/src/index.html`
- Create: `packages/testbench-webview/src/index.css`
- Create: `packages/testbench-webview/test/state.test.ts`
- Modify: `scripts/build-web.mjs`

- [ ] **Step 1: Write failing state and validation tests from current provider behavior**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestbenchState } from '../src/state';

test('state updates selected module ports and parameters immutably', () => {
    const state = TestbenchState.empty().withModules([{ name: 'dut', filepath: 'dut.sv' }]);
    const selected = state.addModule('dut').updatePortSignal(0, 'clk', 'tb_clk');
    assert.equal(selected.entries[0].portSignals.clk, 'tb_clk');
    assert.equal(state.entries.length, 0);
});

test('generate validation requires at least one DUT and valid clocks', () => {
    assert.deepStrictEqual(TestbenchState.empty().validate(), [
        'Add at least one DUT module before generating.',
    ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace @veriflow/testbench-webview`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Define the exact typed message union**

Web-to-host types are `ready`, `getModules`, `addModule`, `removeModule`, `selectModule`, `updateInstanceName`, `updatePortSignal`, `updateParamValue`, `addClock`, `removeClock`, and `generate`. Host-to-web types are `modules`, `moduleAdded`, `moduleRemoved`, `moduleSelected`, `syncEntries`, `addClockRow`, `removeClockRow`, `generated`, `error`, and `validation`. Copy every current payload field and bound module entries to 20.

- [ ] **Step 4: Move current HTML/CSS/JS behavior into focused TypeScript modules**

Preserve labels, controls, row ordering, validation text, module/clock editing, and generated-file feedback. Use DOM construction and `textContent` for dynamic values; do not use string-built HTML for user-controlled names or paths. Use existing icons already represented in the UI; do not redesign the panel.

- [ ] **Step 5: Bootstrap through shared runtime**

`index.ts` reads bootstrap, creates `HostTransport<TestbenchHostEvent, TestbenchCommand, TestbenchPersistedState>`, starts `TestbenchApp`, and sends `ready`. `TestbenchState` is host-independent and unit-tested.

- [ ] **Step 6: Build the new app into canonical artifacts**

Add the complete Testbench descriptor to `build-web.mjs`, include its license metadata, and generate `web-dist/testbench/index.{html,css,js}`.

- [ ] **Step 7: Run package tests and commit Webview source**

Run: `npm test --workspace @veriflow/testbench-webview && npm run build:web`

Expected: PASS and deterministic non-empty Testbench artifacts.

```bash
git add packages/testbench-webview scripts/build-web.mjs web-dist/testbench package-lock.json
git commit -m "feat: extract Testbench Webview application"
```

### Task 6: Replace provider-embedded Testbench source with generated assets

**Files:**
- Modify: `veriflow-vscode/src/testbenchPanel.ts`
- Create: `veriflow-vscode/src/testbenchWebviewSupport.ts`
- Modify: `veriflow-vscode/src/test/testbenchPanel.test.ts`
- Create: `veriflow-vscode/src/test/testbenchAssets.test.ts`
- Create: `tests/webview/testbench.spec.ts`
- Modify: `veriflow-vscode/.vscodeignore`

- [ ] **Step 1: Write a failing no-inline-source provider test**

```typescript
const source = fs.readFileSync(path.join(extensionRoot, 'src/testbenchPanel.ts'), 'utf8');
assert.doesNotMatch(source, /<!DOCTYPE html>|function post\(msg\)/);
assert.match(source, /buildTestbenchWebviewHtml/);
for (const name of ['index.html', 'index.css', 'index.js']) {
    assert.ok(fs.existsSync(path.join(extensionRoot, 'media/testbench', name)));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/testbenchAssets.test.js`

Expected: FAIL because the provider still embeds all source.

- [ ] **Step 3: Add host HTML support and typed message parsing**

`buildTestbenchWebviewHtml` follows the schematic CSP/bootstrap/resource pattern with app `testbench` and host `vscode`. `TestbenchPanel` sets local resource roots to `media/testbench`, loads generated assets, validates incoming command types/payload bounds before dispatch, and retains all existing extension-host generation logic.

- [ ] **Step 4: Remove the provider template literal completely**

Delete `_getHtml()` embedded HTML/CSS/JS. Keep provider message handlers and generator calls; import command/event types from `@veriflow/testbench-webview/shared`.

- [ ] **Step 5: Add browser workflow tests**

Load the basic fixture, add/remove/select two DUT entries, edit an instance, map one port and parameter, add/remove a clock, trigger empty-state validation, generate a valid request, and assert the memory host receives the exact typed payload. Check no console/page errors and a nonblank screenshot.

- [ ] **Step 6: Run Testbench host and browser tests**

Run: `npm run build:vscode && npm test --workspace veriflow-vscode`

Run: `npm run test:webview -- tests/webview/testbench.spec.ts`

Expected: PASS; VSIX inclusion tests list all three Testbench assets.

- [ ] **Step 7: Commit Testbench host migration**

```bash
git add veriflow-vscode/src/testbenchPanel.ts veriflow-vscode/src/testbenchWebviewSupport.ts veriflow-vscode/src/test veriflow-vscode/.vscodeignore tests/webview/testbench.spec.ts web-dist
git commit -m "refactor: load generated Testbench Webview"
```

### Task 7: Port waveform protocols and reusable core utilities to TypeScript

**Files:**
- Create: `packages/waveform-webview/src/protocol.ts`
- Create: `packages/waveform-webview/src/model.ts`
- Delete: `packages/waveform-webview/src/viewer-core.js`
- Create: `packages/waveform-webview/src/core/cache.ts`
- Create: `packages/waveform-webview/src/core/requestTracker.ts`
- Create: `packages/waveform-webview/src/core/retry.ts`
- Create: `packages/waveform-webview/src/core/frameScheduler.ts`
- Create: `packages/waveform-webview/src/core/valueCodec.ts`
- Create: `packages/waveform-webview/src/core/time.ts`
- Create: `packages/waveform-webview/src/core/layoutCodec.ts`
- Create: `packages/waveform-webview/test/core.test.ts`
- Create: `packages/waveform-webview/tsconfig.test.json`
- Modify: `packages/waveform-webview/package.json`

- [ ] **Step 1: Convert existing core assertions into failing TypeScript tests**

Cover `WaveWindowCache`, `RequestTracker`, `BoundedRequestRetry`, `FrameScheduler`, logic value codecs, radix formatting, time scaling, layout serialization, and request-key stability with the same inputs/outputs used by current smoke hooks.

Example:

```typescript
test('bounded retry permits one retry per stable request key', () => {
    const retries = new BoundedRequestRetry(1);
    assert.equal(retries.shouldRetry('window:clk:0:100'), true);
    assert.equal(retries.shouldRetry('window:clk:0:100'), false);
    assert.equal(retries.shouldRetry('window:clk:100:200'), true);
});
```

- [ ] **Step 2: Run core tests to verify they fail**

Run: `npm test --workspace @veriflow/waveform-webview`

Expected: FAIL because core utilities are still global JavaScript.

- [ ] **Step 3: Define the exact waveform message unions**

Host-to-web types include `vcd`, `empty`, `waveformMetadata`, `indexProgress`, `indexReady`, `windowData`, `cursorValues`, `searchResult`, `indexCancelled`, `reloadFailed`, `requestError`, `bridgeError`, and `error`. Web-to-host types include `ready`, `openText`, `saveLayout`, `windowRequest`, `valueRequest`, `searchRequest`, `cancelRequest`, `cancelLoad`, and `retryLoad`. Preserve current generation/request ID semantics and layout schema version 1.

- [ ] **Step 4: Port core globals into focused exported modules**

Create `core/cache.ts`, `core/requestTracker.ts`, `core/retry.ts`, `core/frameScheduler.ts`, `core/valueCodec.ts`, `core/time.ts`, and `core/layoutCodec.ts`. Keep algorithms and constants unchanged. Remove the `globalThis.VeriflowWaveCore` export after all TypeScript imports compile.
Change the package test script to
`tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js`; the test
configuration compiles `src/**/*.ts` and `test/**/*.ts` into `dist-test`.

- [ ] **Step 5: Run core tests and commit**

Run: `npm test --workspace @veriflow/waveform-webview`

Expected: PASS with no `any` in protocol/model public types.

```bash
git add packages/waveform-webview package-lock.json
git commit -m "refactor: port waveform core to TypeScript"
```

### Task 8: Split waveform state, data requests, and viewport behavior

**Files:**
- Create: `packages/waveform-webview/src/state.ts`
- Create: `packages/waveform-webview/src/data/indexedDataSource.ts`
- Create: `packages/waveform-webview/src/data/requestCoordinator.ts`
- Create: `packages/waveform-webview/src/viewport/timeViewport.ts`
- Create: `packages/waveform-webview/src/viewport/layout.ts`
- Create: `packages/waveform-webview/src/viewport/selection.ts`
- Create: `packages/waveform-webview/test/state.test.ts`
- Modify: `packages/waveform-webview/src/index.js`

- [ ] **Step 1: Write failing state-transition tests**

Test empty -> metadata -> indexed ready, generation replacement, late-response discard, window request coalescing, cancellation, signal/group/bus selection, cursor A/B, layout round-trip, vertical scrolling, zoom/pan range clamping, and indexed reload time conversion.

```typescript
function metadata(generation: number): WaveformHostEvent {
    return {
        type: 'waveformMetadata',
        generation,
        fileName: 'fixture.vcd',
        data: {
            version: '',
            date: '',
            timescale: '1ns',
            startTime: 0,
            endTime: 100,
            scopes: [],
            signals: [],
            warnings: [],
        },
    };
}

function windowData(generation: number): WaveformHostEvent {
    return {
        type: 'windowData',
        generation,
        requestId: 'window-1',
        pixelWidth: 800,
        series: [],
    };
}

test('late window data from an old generation is discarded', () => {
    const state = WaveformState.empty().withMetadata(metadata(2));
    const next = reduceHostEvent(state, windowData(1));
    assert.strictEqual(next, state);
});
```

- [ ] **Step 2: Run state tests to verify they fail**

Run: `npm test --workspace @veriflow/waveform-webview`

Expected: FAIL because typed state modules are absent.

- [ ] **Step 3: Implement immutable state and request coordination**

Keep the current request batching limits: max 8192 window pixels, 32768 records, 2 records per pixel, cache size 192, and one retry. `RequestCoordinator` emits typed messages, tracks active keys by generation, cancels superseded work, and exposes no DOM APIs.

- [ ] **Step 4: Implement viewport and persisted-layout units**

Move time conversion, zoom, wheel pan, resize preservation, library/name column widths, selected rows, groups, expanded buses, radix/color/name modes, cursors, and layout schema validation. Unit tests use fixed viewport dimensions; no viewport-width font scaling is introduced.

- [ ] **Step 5: Bridge legacy entry temporarily through typed modules**

Until rendering is ported, `index.js` may call compiled module functions through one temporary `globalThis.__veriflowWaveMigration` object created by TypeScript `migrationBridge.ts`. Add a test that this is the only temporary global and delete it in Task 9.

- [ ] **Step 6: Run tests and commit**

Run: `npm test --workspace @veriflow/waveform-webview`

Expected: PASS for all state/data/viewport cases while current browser behavior remains unchanged.

```bash
git add packages/waveform-webview
git commit -m "refactor: extract waveform state and viewport"
```

### Task 9: Port Canvas rendering and interactions, then remove legacy JavaScript

**Files:**
- Create: `packages/waveform-webview/src/render/canvasRenderer.ts`
- Create: `packages/waveform-webview/src/render/nameList.ts`
- Create: `packages/waveform-webview/src/interaction/pointer.ts`
- Create: `packages/waveform-webview/src/interaction/keyboard.ts`
- Create: `packages/waveform-webview/src/interaction/dragDrop.ts`
- Create: `packages/waveform-webview/src/interaction/contextMenu.ts`
- Create: `packages/waveform-webview/src/app.ts`
- Create: `packages/waveform-webview/src/index.ts`
- Modify: `packages/waveform-webview/src/index.html`
- Modify: `packages/waveform-webview/src/index.css`
- Delete: `packages/waveform-webview/src/index.js`
- Delete: `packages/waveform-webview/src/viewer-transport.js`
- Delete: temporary `migrationBridge.ts`
- Create: `tests/webview/waveform.spec.ts`

- [ ] **Step 1: Write failing renderer pixel and interaction tests**

Use a deterministic fake canvas context for unit tests and Playwright for browser behavior. Assert scalar transitions, bus text, X/Z colors, cursor lines, range overlay, selection rows, context commands, drag reorder, multi-select move/delete, grouped scope add, bus expansion, name mode, radix formatting, search, and resize backing-store preservation.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npm test --workspace @veriflow/waveform-webview`

Run: `npm run test:webview -- tests/webview/waveform.spec.ts`

Expected: FAIL because TypeScript renderer/app are not complete.

- [ ] **Step 3: Port Canvas rendering without visual redesign**

`CanvasRenderer` receives state, visible rows, window data, dimensions, and device pixel ratio; it does not request data or mutate state. Preserve Canvas 2D, current colors, row/header sizes, digital step drawing, bus labels, unknown values, cursor/range overlays, and nonblank backing-store preservation during pending resize data.

- [ ] **Step 4: Port interaction modules with explicit disposal**

Each module binds its DOM listeners in the constructor and returns/disposes them. `WaveformApp` owns state reduction, request effects, rendering schedules, search, layout persistence, and the existing `window.__veriflowWaveViewer` test inspection API. The inspection API is typed and contains only functions required by the current Qt/browser smoke tests.

- [ ] **Step 5: Bootstrap with shared transport and delete legacy globals**

`index.ts` reads waveform bootstrap, creates `HostTransport<WaveformHostEvent, WaveformCommand, WaveformLayout>`, starts the app, and sends `ready` after transport readiness. Delete legacy JS and both `globalThis.VeriflowWaveCore` and migration bridge. Direct `acquireVsCodeApi`, `QWebChannel`, and `window.message` access is absent.

- [ ] **Step 6: Run browser behavior and pixel checks**

The Playwright test loads the fixed waveform fixture, adds signals, expands a bus, zooms/pans, places both cursors, searches a rising edge, saves/reloads layout, and checks no console/page errors. Sample the Canvas and require more than 700 non-background pixels and 80 colored pixels using the same thresholds as `tests/waveform_viewer_smoke.py`.

- [ ] **Step 7: Run package/browser tests and commit**

Run: `npm test --workspace @veriflow/waveform-webview && npm run build:web`

Run: `npm run test:webview -- tests/webview/waveform.spec.ts`

Expected: PASS; remove the waveform preview skip and review the desktop snapshot.

```bash
git add packages/waveform-webview tests/webview/waveform.spec.ts fixtures/waveform web-dist/waveform
git commit -m "refactor: migrate waveform viewer to TypeScript"
```

### Task 10: Remove host-side script rewriting and use static generated waveform assets

**Files:**
- Modify: `veriflow-vscode/src/waveformEditorProvider.ts`
- Create: `veriflow-vscode/src/waveformWebviewSupport.ts`
- Modify: `src/presentation/gui/widgets/waveform_html.py`
- Modify: `src/presentation/gui/widgets/waveform_viewer_panel.py`
- Modify: `tests/test_core_services.py`
- Modify: `tests/test_web_assets.py`
- Modify: `tests/waveform_viewer_smoke.py`
- Create: `veriflow-vscode/src/test/waveformAssets.test.ts`

- [ ] **Step 1: Write failing no-rewrite tests**

```python
def test_python_waveform_host_does_not_rewrite_javascript() -> None:
    from pathlib import Path
    source = (
        Path(__file__).resolve().parents[1]
        / "src/presentation/gui/widgets/waveform_html.py"
    ).read_text(encoding="utf-8")
    assert ".replace(" not in source
    assert "index.js" in source
    assert "veriflow-bootstrap" in source
```

The VS Code asset test applies the same assertion to `waveformEditorProvider.ts` and requires external `index.css`/`index.js` URIs.

- [ ] **Step 2: Run no-rewrite tests to verify they fail**

Run: `python -m pytest tests/test_web_assets.py -v`

Run: `npm run compile:ts --workspace veriflow-vscode && node veriflow-vscode/out/test/waveformAssets.test.js`

Expected: both fail on current inline/string replacement.

- [ ] **Step 3: Build host HTML from static shell plus bootstrap/resource URIs**

VS Code uses CSP resource URIs and nonce for external `index.js`. Qt builds an HTML document with the static body, links or embeds exact generated CSS as required by `setHtml`, includes `qrc:///qtwebchannel/qwebchannel.js`, inserts escaped bootstrap `{version:1, app:'waveform', host:'qt'}`, and includes the generated JS unchanged. Neither host injects VCD data into source text.

- [ ] **Step 4: Use typed initialization messages**

The legacy full-data `_build_waveform_html` waits for `ready` then posts a typed `vcd` event. The indexed Qt panel continues using `WaveformBridge`; it no longer posts a synthetic `empty` through raw `window.postMessage`, and instead sends `empty` through the bridge after ready. VS Code worker startup remains triggered by typed `ready`.

- [ ] **Step 5: Update smoke harness and source assertions**

Keep all existing Qt smoke interactions and pixel thresholds. Update asset names and bootstrap expectations, capture screenshots through `VERIFLOW_SMOKE_SCREENSHOT`, and assert no JavaScript console errors through a `QWebEnginePage.javaScriptConsoleMessage` collector.

- [ ] **Step 6: Run VS Code, Python, and Qt waveform verification**

Run: `npm run build:vscode && npm test --workspace veriflow-vscode`

Run: `python -m pytest tests/test_web_assets.py tests/test_core_services.py -v`

Run: `$env:VERIFLOW_SMOKE_SCREENSHOT='build/waveform-qt.png'; python tests/waveform_viewer_smoke.py`

Expected: all pass, screenshot is nonblank, and no host source contains generated-JS replacement markers.

- [ ] **Step 7: Commit host integration**

```bash
git add veriflow-vscode/src/waveformEditorProvider.ts veriflow-vscode/src/waveformWebviewSupport.ts veriflow-vscode/src/test src/presentation/gui/widgets/waveform_html.py src/presentation/gui/widgets/waveform_viewer_panel.py tests
git commit -m "refactor: load static waveform Webview assets"
```

### Task 11: Enforce visual, console, artifact, and performance gates for all Webviews

**Files:**
- Modify: `tests/webview/playwright.config.ts`
- Modify: `tests/webview/schematic.spec.ts`
- Modify: `tests/webview/testbench.spec.ts`
- Modify: `tests/webview/waveform.spec.ts`
- Create: `tests/webview/snapshots/schematic-desktop.png`
- Create: `tests/webview/snapshots/testbench-desktop.png`
- Create: `tests/webview/snapshots/waveform-desktop.png`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/run_release.py`
- Modify: `README.md`

- [ ] **Step 1: Add a failing generated-artifact and console gate**

Every Playwright test installs both `console` and `pageerror` collectors and asserts both arrays are empty in `afterEach`. Add a test that runs `npm run build:web`, hashes all files under `web-dist`, runs the build again, and requires identical relative paths and SHA-256 values.

- [ ] **Step 2: Run full browser tests to expose remaining failures**

Run: `npm run build:web && npm run test:webview`

Expected before fixes: any unhandled error, blank renderer, unstable screenshot, missing interaction, or artifact drift fails explicitly.

- [ ] **Step 3: Stabilize desktop and mobile framing**

Test Chromium at 1440x900 and 390x844. Toolbars may wrap only where the existing app permits it; buttons, text, boards, Canvas, SVG, and panels cannot overlap or resize due to hover/content. Schematic and waveform primary surfaces retain stable min/max dimensions. Do not redesign colors or layout while fixing overflow.

- [ ] **Step 4: Add rendering-specific nonblank checks**

Waveform uses Canvas pixel thresholds. Schematic asserts SVG node/edge counts plus non-background pixels. Testbench asserts visible module editor, port/parameter controls, and non-background screenshot pixels. Save reviewed desktop baselines; mobile screenshots are assertions, not necessarily committed baselines.

- [ ] **Step 5: Compare waveform interaction benchmarks**

Run the existing waveform benchmark and a Playwright interaction loop for 100 pans, 50 zooms, and 20 resizes. Compare median render/request latency to the pre-migration record in the same environment; fail only when regression exceeds 25% and benchmark variance does not overlap. Record cold load separately.

- [ ] **Step 6: Add fixed CI/release commands**

CI runs `npm run build:web`, `npm run verify:generated`, installs Chromium, runs all Webview tests, then extension tests. `scripts/run_release.py --check` runs the same order before Python tests and packaging. README documents `npm run preview -- <app>` for developers only and explicitly states Python source users consume committed assets without npm.

- [ ] **Step 7: Run the complete frontend gate**

Run: `npm run build:web`

Run: `npm run verify:generated`

Run: `npm run test:webview`

Run: `npm test --workspace @veriflow/webview-runtime`

Run: `npm test --workspace @veriflow/schematic-webview`

Run: `npm test --workspace @veriflow/testbench-webview`

Run: `npm test --workspace @veriflow/waveform-webview`

Run: `npm test --workspace veriflow-vscode`

Run: `python -m pytest`

Run: `python tests/waveform_viewer_smoke.py`

Expected: every command passes, all screenshots are nonblank and reviewed, and browser/Qt consoles have zero unhandled errors.

- [ ] **Step 8: Commit frontend verification**

```bash
git add tests/webview .github/workflows/ci.yml scripts/run_release.py README.md web-dist
git commit -m "test: enforce unified Webview verification"
```

## Plan Completion Gate

Run:

```bash
rg -n "acquireVsCodeApi|QWebChannel" packages/*-webview/src packages/webview-runtime/src
rg -n "\.replace\(" src/presentation/gui/widgets/waveform_html.py veriflow-vscode/src/waveformEditorProvider.ts
npm run verify:generated
npm run test:webview
npm test --workspaces --if-present
python -m pytest
python tests/waveform_viewer_smoke.py
git status --short
```

Expected: the first search finds host APIs only inside `packages/webview-runtime/src/adapters`, the second search finds nothing, all tests pass, and status is clean after committed `web-dist`. Schematic layout/routing outputs must match pre-migration fixtures; layout improvement remains out of scope.

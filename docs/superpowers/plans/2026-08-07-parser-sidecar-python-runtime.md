# Parser Sidecar and Python Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified SEA probe into the production versioned HDL sidecar, ship it in an exact-version Windows wheel, and add a robust Python client plus domain-model adapter without switching current Python consumers yet.

**Architecture:** `@veriflow/parser-worker` hosts one shared `HdlRuntime`, one workspace index, a bounded JSONL server, and a request router for all protocol operations. The executable scans only initialized roots and explicit include/library directories, keeps stdout protocol-only, and emits a checksum/version manifest. Python locates the executable only through `veriflow-hdl-worker`, maintains one lazy process-wide client with a reader thread and pending-request table, applies one bounded restart for unanswered idempotent requests, and maps shared models into existing Python dataclasses.

**Tech Stack:** TypeScript, Node SEA, esbuild, web-tree-sitter, UTF-8 JSONL over anonymous pipes, Python threading/subprocess/atexit, setuptools wheel, PyInstaller, pytest, Node test runner.

---

## File Structure

```text
packages/parser-worker/src/
  limits.ts                    default resource limits and bound checks
  nodeWorkspaceHost.ts         restricted file discovery/read/include resolution
  requestRouter.ts             protocol operation dispatch and cancellation
  jsonlServer.ts               line framing and stdout/stderr discipline
  manifest.ts                  installed runtime checksum/version verification
  main.ts                      executable entry and signal lifecycle
  test/                        router, framing, crash, and executable tests

python-packages/veriflow-hdl-worker/
  src/veriflow_hdl_worker/
    runtime.py                 installed paths and hidden startup flags only
    bin/                       build-populated executable/WASM/manifest

src/infrastructure/hdl_worker_protocol.py  Python envelope and response validation
src/infrastructure/hdl_worker_client.py    process lifecycle and concurrent requests
src/infrastructure/hdl_worker_runtime.py   lazy process-wide client registry
src/domain/services/shared_hdl_service.py  Python domain-model mapping facade
tests/fixtures/hdl-worker/                 deterministic client/adapter fixtures
tests/test_hdl_worker_client.py            fake and real process lifecycle tests
tests/test_shared_hdl_service.py           model mapping and installed worker tests
```

The main Python services keep using their current regex implementations through this plan. Production cutover is explicitly deferred to plan 5.

### Task 1: Replace the feasibility probe with a production request router

**Files:**
- Create: `packages/parser-worker/src/limits.ts`
- Create: `packages/parser-worker/src/nodeWorkspaceHost.ts`
- Create: `packages/parser-worker/src/requestRouter.ts`
- Create: `packages/parser-worker/test/requestRouter.test.ts`
- Create: `packages/parser-worker/test/helpers.ts`
- Modify: `packages/parser-worker/package.json`
- Delete: `packages/parser-worker/src/probe.ts`
- Delete: `packages/parser-worker/src/probe.test.ts`

- [ ] **Step 1: Write failing initialization and pre-initialization tests**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestRouter } from '../src/requestRouter';

test('router rejects parsing before initialize', async () => {
    const router = createRouterFixture();
    const response = await router.dispatch({
        protocolVersion: 1,
        requestId: 'parse-1',
        type: 'parseDocument',
        payload: {
            uri: 'file:///top.sv',
            version: 1,
            text: 'module top; endmodule',
            priority: 'interactive',
            options: { defines: {} },
        },
    });
    assert.equal(response?.ok, false);
    assert.equal(response && !response.ok ? response.error.code : '', 'HDL_NOT_INITIALIZED');
});

test('initialize reports runtime identity and capabilities', async () => {
    const router = createRouterFixture();
    const response = await router.dispatch(initializeRequest('init-1'));
    assert.equal(response?.ok, true);
    assert.deepStrictEqual(
        response?.ok ? response.payload.capabilities : [],
        ['parseDocument', 'indexWorkspace', 'analyzeDependencies', 'getModule', 'cancel', 'dispose']
    );
});
```

`test/helpers.ts` creates real temporary workspace roots, uses the pinned WASM
paths from `VERIFLOW_RUNTIME_WASM` and `VERIFLOW_LANGUAGE_WASM`, and exports
`createRouterFixture`, `initializeRequest`, `createServerFixture`, and
`createManifestFixture`. Each helper owns a `node:test` cleanup hook that
disposes the router and removes only its temporary directory. Tests therefore
exercise the real shared runtime rather than type-casting partial mocks.

- [ ] **Step 2: Run router tests to verify they fail**

Run: `npm test --workspace @veriflow/parser-worker`

Expected: FAIL because `RequestRouter` does not exist.

- [ ] **Step 3: Define concrete default limits**

```typescript
export const DEFAULT_LIMITS = Object.freeze({
    maxLineBytes: 17 * 1024 * 1024,
    maxDocumentBytes: 16 * 1024 * 1024,
    maxWorkspaceFiles: 100_000,
    maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
});

export function clampLimits(requested: typeof DEFAULT_LIMITS): typeof DEFAULT_LIMITS {
    return {
        maxLineBytes: Math.min(requested.maxLineBytes, DEFAULT_LIMITS.maxLineBytes),
        maxDocumentBytes: Math.min(requested.maxDocumentBytes, DEFAULT_LIMITS.maxDocumentBytes),
        maxWorkspaceFiles: Math.min(requested.maxWorkspaceFiles, DEFAULT_LIMITS.maxWorkspaceFiles),
        maxWorkspaceBytes: Math.min(requested.maxWorkspaceBytes, DEFAULT_LIMITS.maxWorkspaceBytes),
        maxStderrBytes: Math.min(requested.maxStderrBytes, DEFAULT_LIMITS.maxStderrBytes),
    };
}
```

Reject zero, negative, non-integer, and non-finite requested limits in protocol validation; the worker may only lower hard maxima.

- [ ] **Step 4: Implement restricted Node workspace access**

`NodeWorkspaceHost` canonicalizes paths with `fs.realpath`, stores initialized scan roots separately from include/library roots, and exposes the exact runtime callbacks:

```typescript
export interface NodeWorkspaceHostOptions {
    workspaceRoots: string[];
    includeDirs: string[];
    libraryDirs: string[];
    limits: typeof DEFAULT_LIMITS;
}

export class NodeWorkspaceHost {
    findFiles(roots: string[], signal?: AbortSignal): Promise<string[]>;
    readFile(uri: string): Promise<{ text: string; version: number; mtimeMs: number; size: number }>;
    includeCandidates(fromUri: string, includePath: string): string[];
    resolveInclude(fromUri: string, includePath: string, candidates?: readonly string[]): Promise<string | undefined>;
}
```

Only `.v`, `.sv`, `.vh`, and `.svh` files are scanned. Directory traversal uses an explicit queue, checks cancellation between entries, rejects symlink escapes after realpath normalization, counts files and bytes before reading, and sorts returned file URIs deterministically.

- [ ] **Step 5: Implement router state and all operations**

`RequestRouter` owns these states:

```typescript
type RouterState = 'created' | 'ready' | 'disposing' | 'disposed' | 'failed';
type ActiveRequest = { controller: AbortController; responseStarted: boolean };
```

Operation behavior is exact:

- `initialize`: allowed once; verify manifest, create `HdlRuntime`, `NodeWorkspaceHost`, `MemoryWorkspaceIndexStore`, `WorkspaceHdlIndex`, and `DependencyAnalyzer`.
- `parseDocument`: call `runtime.parseDocument` with its request AbortSignal.
- `indexWorkspace`: require roots to be a subset of initialized workspace roots; scan and return file/definition/diagnostic summaries.
- `analyzeDependencies`: resolve a top module from the populated index and return file URI compile order, module map, dependency graph, missing modules, and ambiguous modules.
- `getModule`: return one path-qualified definition or `HDL_NOT_FOUND`; an unqualified duplicate is a request error with candidate keys.
- `cancel`: abort `targetRequestId`, discard its eventual response, and return whether an active request was found.
- `dispose`: stop accepting work, abort active requests, dispose index/runtime, return success, then let the JSONL server close.

- [ ] **Step 6: Add router concurrency, path, and cancellation tests**

Cover two queued parses with distinct IDs, cancellation before parse, cancellation during scan, unknown roots, include-directory access, symlink/root escape rejection, deterministic file ordering, duplicate modules, missing modules, and disposal with active work.

Run: `npm test --workspace @veriflow/parser-worker`

Expected: all router tests pass without spawning the executable.

- [ ] **Step 7: Commit the production router**

```bash
git add packages/parser-worker package-lock.json
git commit -m "feat: add parser worker request router"
```

### Task 2: Add bounded JSONL framing and protocol-pure stdout

**Files:**
- Create: `packages/parser-worker/src/jsonlServer.ts`
- Create: `packages/parser-worker/src/main.ts`
- Create: `packages/parser-worker/test/jsonlServer.test.ts`
- Modify: `packages/parser-worker/package.json`

- [ ] **Step 1: Write failing framing tests**

```typescript
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { JsonlServer } from '../src/jsonlServer';

test('server emits exactly one JSON response line per completed request', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const server = new JsonlServer({ input, output, error, router: createRouterFixture() });
    const lines: string[] = [];
    output.setEncoding('utf8');
    output.on('data', chunk => lines.push(...chunk.trimEnd().split('\n')));
    const completion = server.run();
    input.end(`${JSON.stringify(initializeRequest('init'))}\n`);
    await completion;
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).requestId, 'init');
});

test('server rejects a line beyond the configured byte limit without buffering forever', async () => {
    const fixture = createServerFixture({ maxLineBytes: 64 });
    fixture.input.end(`${'x'.repeat(65)}\n`);
    await fixture.completion;
    assert.match(fixture.stderr(), /HDL_REQUEST_TOO_LARGE/);
    assert.equal(fixture.stdout(), '');
});
```

- [ ] **Step 2: Run framing tests to verify they fail**

Run: `npm test --workspace @veriflow/parser-worker`

Expected: FAIL because `JsonlServer` is absent.

- [ ] **Step 3: Implement byte-bounded UTF-8 line framing**

Use a `StringDecoder('utf8')`, track raw bytes before decoding, reject invalid terminal sequences, ignore one optional UTF-8 BOM only at process start, accept `\n` and `\r\n`, reject empty lines, and stop reading when the maximum line length is exceeded. Parse each complete line with `JSON.parse` followed by `parseRequest`.

Write responses with one call:

```typescript
private writeResponse(response: HdlResponse): void {
    this.output.write(`${JSON.stringify(response)}\n`, 'utf8');
}
```

Never call `console.log`; install a logger that writes timestamped bounded diagnostic lines to stderr.

- [ ] **Step 4: Support concurrent dispatch with orderly shutdown**

The read loop does not await each normal operation; it tracks dispatch promises by request ID so multiple requests can be outstanding. `initialize` is serialized before other operations. `dispose` stops input, awaits active dispatch completion after cancellation, writes its response, and closes stdout. EOF triggers graceful disposal without writing a synthetic response.

- [ ] **Step 5: Add the executable entry**

```typescript
import { stdin, stdout, stderr } from 'node:process';
import { JsonlServer } from './jsonlServer';
import { loadAndVerifyRuntimeManifest } from './manifest';
import { RequestRouter } from './requestRouter';

async function main(): Promise<void> {
    const manifest = await loadAndVerifyRuntimeManifest(process.execPath);
    const router = new RequestRouter({ manifest });
    await new JsonlServer({ input: stdin, output: stdout, error: stderr, router }).run();
}

void main().catch(error => {
    stderr.write(`HDL_RUNTIME_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
```

- [ ] **Step 6: Run framing and protocol-purity tests**

Run: `npm test --workspace @veriflow/parser-worker`

Expected: PASS for split chunks, multiple lines per chunk, CRLF, invalid JSON, invalid UTF-8, oversize lines, concurrent completion, cancellation, EOF, and stdout purity.

- [ ] **Step 7: Commit JSONL server**

```bash
git add packages/parser-worker
git commit -m "feat: add bounded parser JSONL server"
```

### Task 3: Build the production SEA executable and verify its manifest

**Files:**
- Create: `packages/parser-worker/src/manifest.ts`
- Create: `packages/parser-worker/test/manifest.test.ts`
- Modify: `scripts/build-parser-probe.mjs` -> rename to `scripts/build-parser-worker.mjs`
- Modify: `scripts/smoke-parser-probe.mjs` -> rename to `scripts/smoke-parser-worker.mjs`
- Modify: `package.json`
- Modify: `packages/parser-worker/sea-config.json`
- Modify: `docs/architecture/hdl-runtime-feasibility.md`

- [ ] **Step 1: Write failing checksum and version tests**

```typescript
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAndVerifyRuntimeManifest } from '../src/manifest';

test('manifest rejects a modified grammar WASM file', async () => {
    const fixture = await createManifestFixture();
    await fixture.appendTo('tree-sitter-systemverilog.wasm', Buffer.from([0]));
    await assert.rejects(
        loadAndVerifyRuntimeManifest(fixture.executable),
        /grammar checksum mismatch/
    );
});
```

- [ ] **Step 2: Run manifest tests to verify they fail**

Run: `npm test --workspace @veriflow/parser-worker`

Expected: FAIL because manifest verification is absent.

- [ ] **Step 3: Define and verify the production manifest**

```typescript
export type RuntimeManifest = {
    manifestVersion: 1;
    protocolVersion: 1;
    packageVersion: string;
    coreVersion: string;
    nodeVersion: string;
    treeSitterVersion: '0.26.11';
    grammarVersion: '0.4.0';
    capabilities: string[];
    files: Record<'parser-worker.exe' | 'web-tree-sitter.wasm' | 'tree-sitter-systemverilog.wasm', {
        size: number;
        sha256: string;
    }>;
};
```

At startup verify the manifest filename, protocol/package/core versions, all three sizes, and both WASM checksums. The executable cannot hash itself reliably while being produced, so build-time manifest records its size and SHA-256 for wheel/Python verification; Node startup verifies external assets and identity fields.

- [ ] **Step 4: Update the builder from probe to production entry**

Rename scripts with `git mv`. Bundle `packages/parser-worker/src/main.ts`, include all shared HDL packages, copy WASM, inject the SEA blob, and write the manifest above. `package.json` changes `build:parser` to `node scripts/build-parser-worker.mjs`.

- [ ] **Step 5: Make the smoke test exercise the complete handshake**

The smoke test starts the real EXE and sends, in order:

1. `initialize` with a temporary workspace, explicit default limits, and UTF-8;
2. `parseDocument` for `module smoke; endmodule`;
3. `indexWorkspace` for the temporary root;
4. `analyzeDependencies` for `smoke`;
5. `dispose`.

It asserts matching request IDs, capabilities, one module, compile-order URI, zero stderr protocol errors, exit code 0, and no non-JSON stdout lines.

- [ ] **Step 6: Build and smoke the production executable**

Run: `npm run build:parser`

Run: `node scripts/smoke-parser-worker.mjs`

Expected: both exit 0 against `.artifacts/parser-worker/parser-worker.exe`.

- [ ] **Step 7: Commit production SEA building**

```bash
git add package.json packages/parser-worker scripts/build-parser-worker.mjs scripts/smoke-parser-worker.mjs docs/architecture/hdl-runtime-feasibility.md
git commit -m "build: package production HDL sidecar"
```

### Task 4: Expand the worker wheel into the production distribution

**Files:**
- Modify: `python-packages/veriflow-hdl-worker/pyproject.toml`
- Modify: `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/runtime.py`
- Modify: `python-packages/veriflow-hdl-worker/src/veriflow_hdl_worker/__init__.py`
- Modify: `scripts/build_parser_probe_wheel.py` -> rename to `scripts/build_parser_worker_wheel.py`
- Modify: `tests/test_parser_probe_package.py` -> rename to `tests/test_hdl_worker_package.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Write failing exact-version and checksum tests**

```python
import hashlib
import json

from veriflow_hdl_worker.runtime import verify_runtime


def test_installed_worker_verifies_every_packaged_file() -> None:
    verified = verify_runtime(expected_version="1.3.2", expected_protocol=1)
    manifest = json.loads(verified.manifest.read_text(encoding="utf-8"))
    for name, path in {
        "parser-worker.exe": verified.executable,
        "web-tree-sitter.wasm": verified.runtime_wasm,
        "tree-sitter-systemverilog.wasm": verified.language_wasm,
    }.items():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert digest == manifest["files"][name]["sha256"]
```

- [ ] **Step 2: Run package tests to verify they fail**

Run: `python -m pytest tests/test_hdl_worker_package.py -v`

Expected: FAIL because `verify_runtime` is absent.

- [ ] **Step 3: Implement installed runtime verification**

`verify_runtime(expected_version, expected_protocol)` loads `manifest.json`, rejects mismatched version/protocol, missing files, size changes, and SHA-256 changes, and returns `RuntimePaths`. Error messages include the installed wheel version and failing filename but never execute a fallback or download.

- [ ] **Step 4: Make the wheel build consume only production output**

Rename the build script with `git mv`; clean the package `bin/` directory, copy the production EXE/WASM/manifest, verify the manifest before building, build one `py3-none-win_amd64` wheel, install it into a temporary target directory, import `runtime.py` from that installed target, and run `verify_runtime`.

- [ ] **Step 5: Add the exact main-package dependency**

In root `pyproject.toml`:

```toml
dependencies = [
  "PySide6>=6.5.0",
  "veriflow-hdl-worker==1.3.2; sys_platform == 'win32' and platform_machine == 'AMD64'"
]
```

Add `build>=1.2.2` to the `build` optional dependency group. Do not add Node or npm as Python dependencies.

- [ ] **Step 6: Build, install, and verify the production wheel**

Run: `python scripts/build_parser_worker_wheel.py`

Run: `python -m pip install --force-reinstall (Get-ChildItem python-packages/veriflow-hdl-worker/dist/*.whl)`

Run: `python -m pytest tests/test_hdl_worker_package.py -v`

Expected: PASS against the installed exact-version wheel.

- [ ] **Step 7: Commit production wheel source**

```bash
git add python-packages/veriflow-hdl-worker scripts/build_parser_worker_wheel.py tests/test_hdl_worker_package.py pyproject.toml
git commit -m "build: ship production HDL worker wheel"
```

### Task 5: Implement Python protocol validation and the concurrent process client

**Files:**
- Create: `src/infrastructure/hdl_worker_protocol.py`
- Create: `src/infrastructure/hdl_worker_client.py`
- Create: `tests/test_hdl_worker_client.py`
- Create: `tests/fixtures/hdl-worker/fake_worker.py`

- [ ] **Step 1: Write failing lazy-start, concurrency, and cancellation tests**

```python
from pathlib import Path

import pytest

from src.infrastructure.hdl_worker_client import HdlWorkerClient, HdlWorkerCancelled


def test_client_starts_lazily_and_matches_out_of_order_responses(fake_worker: Path) -> None:
    client = HdlWorkerClient(executable=fake_worker, request_timeout=2.0)
    assert client.pid is None
    first = client.request_async("getModule", {"name": "slow"})
    second = client.request_async("getModule", {"name": "fast"})
    assert second.result()["name"] == "fast"
    assert first.result()["name"] == "slow"
    assert client.pid is not None
    client.close()


def test_client_discards_late_response_after_cancel(fake_worker: Path) -> None:
    client = HdlWorkerClient(executable=fake_worker, request_timeout=2.0)
    pending = client.request_async("getModule", {"name": "cancel-me"})
    assert pending.cancel()
    with pytest.raises(HdlWorkerCancelled):
        pending.result()
    client.close()
```

- [ ] **Step 2: Run client tests to verify they fail**

Run: `python -m pytest tests/test_hdl_worker_client.py -v`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Define Python envelope validation and stable exceptions**

`hdl_worker_protocol.py` exports `PROTOCOL_VERSION = 1`, `validate_response(value, expected_request_id, expected_type)`, and exceptions:

```python
class HdlWorkerError(RuntimeError):
    pass


class HdlWorkerProtocolError(HdlWorkerError):
    pass


class HdlWorkerRuntimeError(HdlWorkerError):
    pass


class HdlWorkerRequestError(HdlWorkerError):
    def __init__(self, code: str, message: str, details: Optional[dict] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class HdlWorkerCancelled(HdlWorkerError):
    pass
```

Validation rejects non-dicts, wrong protocol/request/type, non-boolean `ok`, success without payload, failure without bounded error code/message, both payload and error, and JSON nesting deeper than 32.

- [ ] **Step 4: Implement client process and pending-request state**

The client owns the following pending record; public methods are implemented
as normal methods rather than interface stubs:

```python
@dataclass
class _Pending:
    request_id: str
    request_type: str
    future: Future
    idempotent: bool
    response_started: bool = False
```

`HdlWorkerClient.request()` calls `request_async()` and waits with the explicit
argument or configured default timeout. `request_async()` allocates and stores
the pending future before the serialized write, `initialize()` persists the
last successful configuration for restart, and `close()` performs graceful
dispose followed by bounded terminate/kill fallback. All new Python files use
`from __future__ import annotations` and `typing.Optional` in public signatures
to preserve the declared Python 3.8 minimum.

Start with `shell=False`, binary pipes, `CREATE_NO_WINDOW`, and the executable returned by installed-wheel verification. A dedicated reader thread uses `readline()` with a maximum configured length, decodes strict UTF-8, parses JSON, validates the envelope, and completes the matching `Future`. A bounded deque retains only the last 64 KiB of stderr bytes. Writes are serialized by one lock; callbacks never run while internal locks are held.

- [ ] **Step 5: Implement cancellation, timeout, crash, and one restart**

Cancel completes the local future with `HdlWorkerCancelled`, removes it from `_pending`, then sends a separate `cancel` request. Timeout uses the same local terminal path. Unexpected EOF rejects every pending future immediately with runtime version, exit code, and stderr tail.

Automatic restart is allowed once in a 30-second window only when all of these are true: the operation is one of `parseDocument`, `indexWorkspace`, `analyzeDependencies`, or `getModule`; no response line began; the request was not cancelled; and the client can repeat the last successful initialize payload. A second crash disables restart until a new client is created.

- [ ] **Step 6: Add fake-worker failure matrix tests**

The fake worker supports modes selected by request payload: out-of-order success, late response, malformed JSON, wrong request ID, stderr flooding, immediate crash, crash after response prefix, delayed success, and clean dispose. Assert stdout parsing, bounded stderr, one restart only, no retry after response prefix, all pending rejection, idempotent retry, and reader/process/thread cleanup.

Run: `python -m pytest tests/test_hdl_worker_client.py -v`

Expected: PASS with no child process or reader thread remaining.

- [ ] **Step 7: Commit the Python client**

```bash
git add src/infrastructure/hdl_worker_protocol.py src/infrastructure/hdl_worker_client.py tests/test_hdl_worker_client.py tests/fixtures/hdl-worker/fake_worker.py
git commit -m "feat: add Python HDL worker client"
```

### Task 6: Add one lazy process-wide runtime registry

**Files:**
- Create: `src/infrastructure/hdl_worker_runtime.py`
- Modify: `src/presentation/gui/__main__.py`
- Modify: `src/presentation/gui/main_window.py`
- Create: `tests/test_hdl_worker_runtime.py`

- [ ] **Step 1: Write failing singleton and shutdown tests**

```python
from src.infrastructure.hdl_worker_runtime import (
    get_hdl_worker_client,
    shutdown_hdl_worker,
)


def test_runtime_registry_returns_one_lazy_client(monkeypatch) -> None:
    created = []
    monkeypatch.setattr(
        "src.infrastructure.hdl_worker_runtime.HdlWorkerClient",
        lambda: created.append(object()) or FakeClient(),
    )
    first = get_hdl_worker_client()
    second = get_hdl_worker_client()
    assert first is second
    assert len(created) == 1
    shutdown_hdl_worker()
    assert first.closed
```

- [ ] **Step 2: Run registry tests to verify they fail**

Run: `python -m pytest tests/test_hdl_worker_runtime.py -v`

Expected: FAIL because the registry is absent.

- [ ] **Step 3: Implement a lock-protected registry and idempotent shutdown**

```python
_lock = threading.RLock()
_client: Optional[HdlWorkerClient] = None


def get_hdl_worker_client() -> HdlWorkerClient:
    global _client
    with _lock:
        if _client is None:
            _client = HdlWorkerClient()
        return _client


def shutdown_hdl_worker() -> None:
    global _client
    with _lock:
        client, _client = _client, None
    if client is not None:
        client.close()
```

Register `shutdown_hdl_worker` with `atexit` once. The registry creates the client object lazily; the client creates the process only on initialize/request.

- [ ] **Step 4: Wire explicit GUI shutdown without blocking the UI thread indefinitely**

Connect `QApplication.aboutToQuit` to `shutdown_hdl_worker`. In `MainWindow.closeEvent`, finish existing GUI worker threads first, then call shutdown; `HdlWorkerClient.close()` allows 2 seconds for graceful dispose and then terminates/kills with bounded waits.

- [ ] **Step 5: Run shutdown tests**

Run: `python -m pytest tests/test_hdl_worker_runtime.py -v`

Expected: PASS for repeated get/shutdown, concurrent get, atexit registration, graceful close, and forced termination.

- [ ] **Step 6: Commit runtime registry**

```bash
git add src/infrastructure/hdl_worker_runtime.py src/presentation/gui/__main__.py src/presentation/gui/main_window.py tests/test_hdl_worker_runtime.py
git commit -m "feat: manage one Python HDL worker process"
```

### Task 7: Map shared results into current Python domain models

**Files:**
- Create: `src/domain/services/shared_hdl_service.py`
- Create: `tests/test_shared_hdl_service.py`
- Create: `tests/fixtures/hdl-worker/models.sv`

- [ ] **Step 1: Write failing module and dependency mapping tests**

```python
from pathlib import Path

from src.domain.services.shared_hdl_service import SharedHdlService


def test_shared_service_maps_module_ports_parameters_and_dependencies(fake_hdl_client) -> None:
    service = SharedHdlService(client=fake_hdl_client)
    info = service.parse_file(Path("models.sv"), module_name="child")
    assert info.name == "child"
    assert [(item.name, item.value) for item in info.parameters] == [("WIDTH", "8")]
    assert [(item.direction, item.name, item.width) for item in info.ports] == [
        ("input", "clk", None),
        ("input", "data_i", "[WIDTH-1:0]"),
        ("output", "data_o", "[WIDTH-1:0]"),
    ]
    assert info.dependencies == ["leaf"]


def test_shared_service_maps_deterministic_compile_order(fake_hdl_client) -> None:
    result = SharedHdlService(client=fake_hdl_client).analyze_dependencies(
        "top", [Path("rtl")]
    )
    assert [path.name for path in result.get_compile_order()] == ["leaf.sv", "top.sv"]
    assert result.missing_modules == []
```

- [ ] **Step 2: Run adapter tests to verify they fail**

Run: `python -m pytest tests/test_shared_hdl_service.py -v`

Expected: FAIL because `SharedHdlService` does not exist.

- [ ] **Step 3: Implement explicit width and source mapping helpers**

```python
def _port(model: dict) -> Port:
    packed_range = model.get("packedRange")
    width_msb = width_lsb = None
    match = re.fullmatch(r"\[(\d+)\s*:\s*(\d+)\]", packed_range or "")
    if match:
        width_msb, width_lsb = int(match.group(1)), int(match.group(2))
    return Port(
        name=model["name"],
        direction=model["direction"],
        width=packed_range,
        width_msb=width_msb,
        width_lsb=width_lsb,
    )
```

Map parameter defaults verbatim, preserve port/parameter order, set `filepath` from file URIs, use sorted unique dependency names, include raw include paths, and reject a missing/ambiguous requested module with `ValueError` that includes candidate locations.

- [ ] **Step 4: Implement service operations without production fallback**

`parse_content(content, filename="module", module_name=None)` sends an
ephemeral `parseDocument` request. `parse_file(path, module_name=None)` reads
strict UTF-8 and delegates to `parse_content` with a file URI. A file with
multiple modules requires `module_name` unless exactly one module is present.
`index_workspace(roots, include_dirs=(), library_dirs=(), defines=None)`
performs initialize once per configuration fingerprint and sends
`indexWorkspace`. `analyze_dependencies(top_module, roots, ...)` returns the
existing `DependencyResult`. `scan_modules` returns path-qualified definitions
and duplicate groups for future coordinator cutover.

The service never catches worker errors to invoke regex parsing.

- [ ] **Step 5: Test fake mapping and real installed worker integration**

Run: `python -m pytest tests/test_shared_hdl_service.py -v`

Expected: fake-client mapping tests pass.

Run: `$env:VERIFLOW_RUN_REAL_HDL_WORKER='1'; python -m pytest tests/test_shared_hdl_service.py -v`

Expected: installed worker parses `models.sv`, indexes it, resolves dependencies, and returns the same asserted domain models.

- [ ] **Step 6: Commit the Python shared service**

```bash
git add src/domain/services/shared_hdl_service.py tests/test_shared_hdl_service.py tests/fixtures/hdl-worker/models.sv
git commit -m "feat: map shared HDL models into Python"
```

### Task 8: Verify installed wheel and PyInstaller integration end to end

**Files:**
- Modify: `VeriFlow.spec`
- Modify: `VeriFlow-cli.spec`
- Modify: `tests/test_hdl_worker_package.py`
- Create: `scripts/smoke_installed_hdl_worker.py`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing PyInstaller collection assertions**

```python
def test_application_specs_collect_installed_worker_distribution() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for name in ("VeriFlow.spec", "VeriFlow-cli.spec"):
        text = (root / name).read_text(encoding="utf-8")
        assert "collect_data_files('veriflow_hdl_worker')" in text
        assert ".artifacts/parser-worker" not in text
```

- [ ] **Step 2: Run assertion to verify it fails**

Run: `python -m pytest tests/test_hdl_worker_package.py::test_application_specs_collect_installed_worker_distribution -v`

Expected: FAIL because application specs do not collect the wheel.

- [ ] **Step 3: Collect only installed distribution data**

At the top of both specs:

```python
from PyInstaller.utils.hooks import collect_data_files

worker_datas = collect_data_files('veriflow_hdl_worker')
```

Append `worker_datas` to `Analysis.datas`. Do not reference the source package `bin/`, build artifacts, npm directories, or Node executable.

- [ ] **Step 4: Add a no-Node installed-runtime smoke script**

The script asserts `shutil.which('node') is None` and `shutil.which('npm') is None`, obtains the process-wide client, initializes a temporary workspace, parses and indexes `module installed; endmodule`, disposes the client, and uses `psutil` only in the test environment to assert the child PID no longer exists.

- [ ] **Step 5: Run real build and package smoke tests**

Run: `npm run build:parser`

Run: `python scripts/build_parser_worker_wheel.py`

Run: `python -m pip install --force-reinstall (Get-ChildItem python-packages/veriflow-hdl-worker/dist/*.whl)`

Run: `python -m pytest tests/test_hdl_worker_package.py tests/test_hdl_worker_client.py tests/test_hdl_worker_runtime.py tests/test_shared_hdl_service.py -v`

Run: `pyinstaller VeriFlow-cli.spec --noconfirm`

Run the CLI smoke from a PowerShell process whose `PATH` contains the test virtual environment and Windows system directories but no Node/npm directories.

Expected: parsing succeeds and no `parser-worker.exe` process remains.

- [ ] **Step 6: Extend Windows CI in the fixed release order**

After building/installing the worker wheel, run Python client/integration tests, then build PyInstaller artifacts, then invoke the no-Node smoke. Retain VSIX packaging after Python artifact verification.

- [ ] **Step 7: Commit installed-runtime integration**

```bash
git add VeriFlow.spec VeriFlow-cli.spec tests/test_hdl_worker_package.py scripts/smoke_installed_hdl_worker.py .github/workflows/ci.yml
git commit -m "test: verify installed HDL worker runtime"
```

## Plan Completion Gate

Run on Windows x64:

```bash
npm ci
npm test --workspace @veriflow/parser-worker
npm run build:parser
node scripts/smoke-parser-worker.mjs
python scripts/build_parser_worker_wheel.py
python -m pytest tests/test_hdl_worker_package.py tests/test_hdl_worker_client.py tests/test_hdl_worker_runtime.py tests/test_shared_hdl_service.py -v
pyinstaller VeriFlow-cli.spec --noconfirm
python scripts/smoke_installed_hdl_worker.py
git status --short
```

Expected: all commands pass, the final status is clean after commits, no worker remains running, and current `PortParserService`/`DependencyAnalyzerService` production consumers are still unchanged. The migration proceeds to Webview unification before Python cutover.

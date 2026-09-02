# Arch Design Authoring UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Arch Design inputs default safely, preserve exact duplicate-module identity, generate instance names automatically, add complete editor shortcuts, and remove all npm audit findings.

**Architecture:** Keep the existing shared Tree-sitter and `WorkspaceHdlIndex` frontend. Extend the host-neutral Arch Design instance model with an optional exact definition reference, resolve explicit references before legacy name lookup, represent implicit input zeroes in the existing effective-default pipeline, and route toolbar buttons and keyboard shortcuts through common webview actions.

**Tech Stack:** TypeScript 5.9, Node.js test runner, VS Code custom editor APIs, X6 schematic webview, Playwright Electron tests, npm workspaces.

---

### Task 1: Persist Exact Module Definition References

**Files:**
- Modify: `packages/schematic-core/src/archDesign/model.ts:15`
- Modify: `packages/schematic-core/src/archDesign/parser.ts:330`
- Modify: `packages/schematic-core/src/archDesign/serializer.ts:40`
- Modify: `packages/schematic-core/src/archDesign/resolution.ts:230`
- Test: `packages/schematic-core/test/archDesignParser.test.ts`
- Test: `packages/schematic-core/test/archDesignSerialization.test.ts`
- Test: `packages/schematic-core/test/archDesignEdit.test.ts`

**Step 1: Write failing schema and round-trip tests**

Add cases that parse, freeze, edit, serialize, and round-trip this instance while retaining the optional field:

```ts
{
    name: 'u_core_0',
    module: 'core',
    definitionKey: 'module:file:///workspace/rtl/core.v:0',
}
```

Keep an adjacent assertion that `{ name: 'u_core_0', module: 'core' }` remains valid and serializes without `definitionKey`.

**Step 2: Run focused tests and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignParser.test.js \
  packages/schematic-core/dist-test/test/archDesignSerialization.test.js \
  packages/schematic-core/dist-test/test/archDesignEdit.test.js
```

Expected: assertions fail because `definitionKey` is discarded.

**Step 3: Implement the optional field**

Extend the model:

```ts
export type ArchDesignInstance = Readonly<{
    name: string;
    module: string;
    definitionKey?: string;
    parameters?: Readonly<Record<string, ArchDesignParameterValue>>;
}>;
```

Normalize `definitionKey` as a non-empty string only when present. Include it in `instanceValue()` before parameters, and copy it in every instance snapshot/edit path. Do not require it for schema version 1.

**Step 4: Run focused tests and verify GREEN**

Repeat Step 2. Expected: all selected files pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesign{Parser,Serialization,Edit}.test.ts
git commit -m "feat(ad): persist module definition identity"
```

### Task 2: Resolve Duplicate Modules by Exact Identity

**Files:**
- Modify: `packages/schematic-core/src/archDesign/resolution.ts:489`
- Test: `packages/schematic-core/test/archDesignValidation.test.ts:50`
- Test: `packages/schematic-core/test/archDesignGraph.test.ts`

**Step 1: Write the failing duplicate-definition test**

Create two `ArchDesignModuleDefinition` objects named `duplicate` with distinct keys and distinct port sets. Assert that:

```ts
instances: [{
    name: 'u_duplicate_0',
    module: 'duplicate',
    definitionKey: secondDefinition.key,
}]
```

validates without `AD_MODULE_AMBIGUOUS`, resolves `secondDefinition`, and projects only its ports. Keep the existing legacy name-only case and assert that it remains ambiguous.

Add stale-reference coverage: an explicit missing key must produce an unresolved-definition diagnostic at `$.instances[0].definitionKey` and must not fall back to another same-named definition.

**Step 2: Run tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignValidation.test.js \
  packages/schematic-core/dist-test/test/archDesignGraph.test.js
```

Expected: explicit identity is ignored and the selected duplicate remains ambiguous.

**Step 3: Implement exact-first resolution**

Build a definition map by `key`. For each instance:

```ts
const explicit = instance.definitionKey;
const matches = catalog.get(instance.module) ?? [];
const definition = explicit === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : definitionsByKey.get(explicit);
```

For an explicit reference, require both an exact key match and the same module name. Emit a specific unresolved/mismatch diagnostic on `.definitionKey`; never guess among duplicates. Preserve current unresolved and ambiguous diagnostics for legacy name-only instances.

**Step 4: Run tests and verify GREEN**

Repeat Step 2. Expected: exact duplicate selection passes and legacy ambiguity remains covered.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/resolution.ts \
  packages/schematic-core/test/archDesignValidation.test.ts \
  packages/schematic-core/test/archDesignGraph.test.ts
git commit -m "fix(ad): bind duplicate modules by definition key"
```

### Task 3: Make Undriven Instance Inputs Implicit Zeroes

**Files:**
- Modify: `packages/schematic-core/src/archDesign/resolution.ts:98`
- Test: `packages/schematic-core/test/archDesignValidation.test.ts:389`
- Test: `packages/schematic-core/test/archDesignGraph.test.ts`
- Test: `packages/schematic-core/test/archDesignRtl.test.ts:183`

**Step 1: Replace the old failing-behavior expectation**

Change the required connected-load test to use an instance input and expect:

```ts
{
    endpoint: 'u_sink.data_i',
    expression: '0',
    origin: 'implicit-zero',
}
```

Cover both a completely unconnected instance input and an instance input on a driverless scalar connection. Add a separate top-level output case that still expects `AD_UNDRIVEN_INPUT`.

Add graph and RTL assertions that the constant node is projected and generated text includes `.data_i(0)` for an otherwise unconnected input. Retain an explicit override assertion such as `.data_i(8'hff)`.

**Step 2: Run tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignValidation.test.js \
  packages/schematic-core/dist-test/test/archDesignGraph.test.js \
  packages/schematic-core/dist-test/test/archDesignRtl.test.js
```

Expected: `AD_UNDRIVEN_INPUT` is emitted and no implicit constant is exported.

**Step 3: Add a real implicit default**

Extend the origin type:

```ts
export type ArchDesignDefaultOrigin =
    'connection' | 'design' | 'implicit-inout-t' | 'implicit-zero';
```

In effective-default selection, after explicit connection/design defaults and the existing inout rule, add an implicit `0` only when `endpoint.kind === 'instance'`. Add it even when the endpoint is on a driverless connection so the existing connection default-source selection can drive all loads. Leave top-level receiver diagnostics unchanged.

**Step 4: Run tests and verify GREEN**

Repeat Step 2. Expected: implicit and overridden RTL both pass; top-level output coverage still reports the error.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/resolution.ts \
  packages/schematic-core/test/archDesign{Validation,Graph,Rtl}.test.ts
git commit -m "feat(ad): default undriven instance inputs to zero"
```

### Task 4: Edit Input Defaults from the Pin Inspector

**Files:**
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts:640`
- Test: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts:300`

**Step 1: Write the failing Inspector projection test**

Select an instance input pin and assert a `pin-default` text field with explicit value or an empty value plus `Implicit default: 0`. Its commit must produce:

```ts
{ type: 'setDefault', endpoint: 'u_core.clk', expression: "1'b1" }
```

Clearing it must omit `expression`. Assert that output and inout pins do not receive the field.

**Step 2: Run the test and verify RED**

```bash
npm run compile:ts --workspace veriflow
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
```

Expected: `pin-default` is absent.

**Step 3: Add the input-only field**

In `projectPinAuthoringInspector`, when the resolved HDL direction is `input`, read `design.defaults[endpointDefaultKey(...)]`, append a text field, trim commits, and use the existing `setDefault` edit. The field edits the endpoint-level design default whether the pin is disconnected or belongs to a driverless network; connection defaults continue to take precedence.

**Step 4: Run the test and verify GREEN**

Repeat Step 2. Expected: all webview support tests pass.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/schematic/webviewSupport.ts \
  veriflow-vscode/src/test/schematicWebviewSupport.test.ts
git commit -m "feat(ad): edit input defaults from pin inspector"
```

### Task 5: Publish Source-Aware Module Choices

**Files:**
- Modify: `veriflow-vscode/src/schematic/protocol.ts:60`
- Modify: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts:1`
- Modify: `veriflow-vscode/src/archDesign/editorSupport.ts:222`
- Test: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`
- Test: `veriflow-vscode/src/test/archDesignEditorSupport.test.ts`

**Step 1: Write failing provider tests**

Provide two summaries with the same module name, different `uri`, `key`, and ports. Assert the editable `archDesignState` contains two choices with exact keys and distinct relative source descriptions, and the domain catalog still contains both full definitions.

Assert `toArchDesignModuleDefinitions` preserves the shared summary's identity and port data without syntax parsing.

**Step 2: Run tests and verify RED**

```bash
npm run compile:ts --workspace veriflow
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
node veriflow-vscode/out/test/archDesignEditorSupport.test.js
```

Expected: the protocol has no source-aware choices.

**Step 3: Reuse the existing choice builder**

Add a protocol type containing:

```ts
type ArchDesignModuleChoice = Readonly<{
    label: string;
    description: string;
    moduleName: string;
    definitionKey: string;
}>;
```

Use `buildModuleInstantiationChoices(sourceDefinitions, workspaceRoot)` in the provider and publish the mapped results beside `catalog`. Derive the root from `vscode.workspace.getWorkspaceFolder(document.uri)` with a deterministic document-directory fallback. Do not add any port parser.

**Step 4: Run tests and verify GREEN**

Repeat Step 2. Expected: both duplicate choices and existing provider tests pass.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/schematic/protocol.ts \
  veriflow-vscode/src/archDesign/archDesignEditorProvider.ts \
  veriflow-vscode/src/archDesign/editorSupport.ts \
  veriflow-vscode/src/test/archDesignEditor{Provider,Support}.test.ts
git commit -m "feat(ad): publish source-aware module choices"
```

### Task 6: Generate Instance Names and Preserve Definition Selection

**Files:**
- Modify: `packages/schematic-webview/src/index.html:63`
- Modify: `packages/schematic-webview/src/index.ts:1999`
- Test: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Test: `veriflow-vscode/src/test/schematicAssets.test.ts`

**Step 1: Write the failing Electron scenario**

Publish an editable Arch Design fixture with duplicate source-aware choices and existing instances `u_alu_0` and `u_uart_0`. Assert:

- both `alu` choices are visible with different paths;
- opening Add Instance prefills `u_alu_1`;
- selecting `uart` proposes `u_uart_1`;
- switching between two `alu` definitions keeps the shared `alu` sequence;
- manually typing `custom_name` prevents later selector changes from overwriting it;
- submit posts an `addInstance` edit containing name, module name, and the selected `definitionKey`.

Add static asset assertions for Module-before-Instance form order.

**Step 2: Build and run the focused Electron test to verify RED**

```bash
npm run build:vscode
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
node --test --test-name-pattern="Arch Design generates source-aware instance names" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: choices are collapsed and the name is empty.

**Step 3: Implement dialog behavior**

Render one option per `moduleChoices` entry with `definitionKey` as its value and `moduleName (description)` as visible text. Reorder the form to focus the module selector first.

Compute the lowest free suffix from current `design.instances` with an escaped regular expression matching exactly `u_<module>_<digits>`. Track whether the current input remains an automatically generated proposal. Refresh it on selector changes only while automatic; any user input marks it manual. Submit the selected choice as:

```ts
{
    type: 'addInstance',
    instance: { name, module: choice.moduleName, definitionKey: choice.definitionKey },
}
```

**Step 4: Run focused tests and verify GREEN**

Repeat Step 2, then run:

```bash
node veriflow-vscode/out/test/schematicAssets.test.js
```

Expected: focused Electron and asset tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-webview/src/index.{html,ts} \
  packages/waveform-desktop/test/schematicWebview.test.ts \
  veriflow-vscode/src/test/schematicAssets.test.ts
git commit -m "feat(ad): streamline source-aware instance creation"
```

### Task 7: Route Every Arch Design Toolbar Operation Through Shortcuts

**Files:**
- Modify: `packages/schematic-webview/src/index.html:14`
- Modify: `packages/schematic-webview/src/index.ts:2189`
- Test: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Test: `veriflow-vscode/src/test/schematicAssets.test.ts`

**Step 1: Write failing keyboard behavior tests**

In one focused Electron test, exercise `A`, `P`, `C`, `Delete`, `E`, `F`, `0`, `R`, `M`, `I`, `Ctrl+F`, Enter navigation, and Escape cancellation. Assert that single-letter commands do not run while an input, select, textarea, contenteditable element, or modal dialog owns focus. Assert disabled commands remain no-ops.

Add static assertions for the agreed `aria-keyshortcuts` values on toolbar controls.

**Step 2: Build and run the focused test to verify RED**

```bash
npm run build:vscode
npm run build --workspace @veriflow/waveform-desktop
npx tsc -p packages/waveform-desktop/tsconfig.test.json
node --test --test-name-pattern="Arch Design keyboard shortcuts" \
  packages/waveform-desktop/dist-test/test/schematicWebview.test.js
```

Expected: keys do not invoke toolbar actions.

**Step 3: Extract shared action functions**

Move each button listener body into a named function such as `fitSchematic`, `toggleSearch`, `relayoutSchematic`, `showAddInstanceDialog`, `toggleConnectionMode`, `exportRtl`, and `deleteSelection`. Keep button listeners as thin calls to these functions.

Add one document-level dispatcher. Ignore composing/repeated events, modifier combinations other than search, non-Arch-Design single keys, editable targets, and open dialogs. Call `preventDefault()` only when a shortcut is actually handled. Preserve local search and canvas Enter handlers and make Escape close the active dialog/search before canceling a pending connection.

**Step 4: Run focused tests and verify GREEN**

Repeat Step 2 and run the asset test. Expected: every mapped action and focus guard passes.

**Step 5: Commit**

```bash
git add packages/schematic-webview/src/index.{html,ts} \
  packages/waveform-desktop/test/schematicWebview.test.ts \
  veriflow-vscode/src/test/schematicAssets.test.ts
git commit -m "feat(ad): add editor keyboard shortcuts"
```

### Task 8: Upgrade Vulnerable Development Dependencies

**Files:**
- Modify: `package-lock.json`

**Step 1: Record the current audit boundary**

```bash
npm audit --omit=dev
npm audit
```

Expected before the change: production audit reports 0; full audit reports 7 findings, 5 high and 2 moderate.

**Step 2: Apply compatible patched transitive versions**

```bash
npm audit fix
```

Do not use `--force`. Review `git diff -- package-lock.json` and confirm there are no direct dependency major upgrades or unrelated manifest changes.

Expected patched packages include `brace-expansion`, `fast-uri`, `form-data`, `linkify-it`, `markdown-it`, `qs`, and `tmp`.

**Step 3: Verify audits and clean installation**

```bash
npm audit --omit=dev
npm audit
npm ci
```

Expected: both audits report 0 vulnerabilities and `npm ci` succeeds.

**Step 4: Commit**

```bash
git add package-lock.json
git commit -m "chore(deps): resolve npm audit findings"
```

### Task 9: Full Verification and Documentation Consistency

**Files:**
- Modify if required: `docs/DECISIONS.md`
- Modify if required: `docs/plans/2026-08-09-schematic-arch-design-design.md`

**Step 1: Update superseded default semantics**

Record that undriven instance inputs implicitly use zero while undriven public outputs remain errors. Remove or qualify older text that says every required undriven instance load is invalid. Do not mention or expose the TypeScript simulator backend.

**Step 2: Run focused typechecks and tests**

```bash
npm run typecheck:shared
npm run typecheck --workspace @veriflow/schematic-webview
npm run compile:ts --workspace veriflow
npm test --workspace @veriflow/schematic-core
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
node veriflow-vscode/out/test/archDesignEditorSupport.test.js
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/schematicAssets.test.js
```

Expected: all pass.

**Step 3: Run the complete repository suite**

```bash
npm test
npm run test:release
npm run package --workspace veriflow
npm run test:vsix --workspace veriflow
npm audit --omit=dev
npm audit
git status --short
```

Expected: all tests and packaging pass, both audits report zero, and only intentional documentation changes remain before the final commit.

**Step 4: Commit documentation, if changed**

```bash
git add docs/DECISIONS.md docs/plans/2026-08-09-schematic-arch-design-design.md
git commit -m "docs(ad): record implicit input defaults"
```

**Step 5: Inspect final history**

```bash
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
```

Expected: implementation is split by behavior, with no generated build output or unrelated files tracked.

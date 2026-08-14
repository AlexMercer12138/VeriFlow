# Arch Design Creation Entry Points Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add discoverable Arch Design creation and file management to the VS Code extension, add `veriflow ad new` to the Node CLI, and remove duplicate AD editor-title actions.

**Architecture:** The host-neutral schematic core owns the canonical empty `.ad` text factory. The CLI writes that text with exclusive local-file creation, while the extension adapts the same factory to VS Code workspace URIs through a small testable creation workflow. A dedicated TreeDataProvider discovers `.ad` resources independently from HDL scanning, and manifest contributions expose create, refresh, open, validate, and export actions without duplicating in-editor toolbar actions.

**Tech Stack:** TypeScript, Node.js 24, VS Code Extension API, npm workspaces, `node:test`

---

### Task 1: Canonical Empty Arch Design Text

**Files:**
- Modify: `packages/schematic-core/src/archDesign/serializer.ts`
- Modify: `packages/schematic-core/test/archDesignModel.test.ts`

**Step 1: Write the failing shared-core test**

Import `createEmptyArchDesignText` and `parseArchDesignText`, then add a test that checks exact canonical bytes and a successful parse:

```ts
test('creates canonical empty Arch Design text', () => {
    const text = createEmptyArchDesignText('soc_top');
    assert.equal(text, [
        '{',
        '  "format": "vik-veriflow.arch-design",',
        '  "schemaVersion": 1,',
        '  "module": "soc_top",',
        '  "ports": [],',
        '  "instances": [],',
        '  "connections": [],',
        '  "interfacePorts": [],',
        '  "interfaceOverrides": {},',
        '  "interfaceConnections": [],',
        '  "defaults": {},',
        '  "export": {},',
        '  "presentation": {}',
        '}',
        '',
    ].join('\n'));
    const parsed = parseArchDesignText(text);
    assert.equal(parsed.status, 'editable');
    if (parsed.status === 'editable') assert.equal(parsed.design.module, 'soc_top');
});
```

Extend the invalid-module test so the text factory rejects the same invalid names as the model factory.

**Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
```

Expected: TypeScript fails because `createEmptyArchDesignText` is not exported.

**Step 3: Implement the shared factory**

In `serializer.ts`, import the value factory and add:

```ts
export function createEmptyArchDesignText(module: string): string {
    return serializeArchDesign(createEmptyArchDesign(module));
}
```

The existing `archDesign/index.ts` wildcard export exposes it through `@veriflow/schematic-core/arch-design`.

**Step 4: Run the shared-core tests**

Run: `npm test --workspace @veriflow/schematic-core`

Expected: all schematic-core tests pass, with only the existing optional Icarus test allowed to skip.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/serializer.ts packages/schematic-core/test/archDesignModel.test.ts
git commit -m "feat(ad): share empty design text factory"
```

### Task 2: Node CLI `ad new`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/commands/ad.ts`
- Modify: `packages/cli/test/parserCompatibility.test.ts`
- Modify: `packages/cli/test/adCommand.test.ts`
- Modify: `tests/cli_contract/cases.json`

**Step 1: Write failing parser and help tests**

Add parser coverage for:

```ts
await invoke(['ad', '--help']);
await invoke(['ad', 'new', '--help']);
await invoke(['ad', 'new']);
await invoke(['ad', 'new', 'soc_top', '-o', 'design/soc']);
```

Assert that parent help lists `new`, leaf help shows `MODULE` and `-o/--output`, a missing module is a parse error, and both short and long output options parse.

**Step 2: Write failing file-creation tests**

In `adCommand.test.ts`, cover:

```ts
const created = await invoke(['ad', 'new', 'soc_top'], cwd);
assert.equal(readFileSync(path.join(cwd, 'soc_top.ad'), 'utf8'),
    createEmptyArchDesignText('soc_top'));

await invoke(['ad', 'new', 'soc_top', '-o', 'design/system'], cwd);
assert.ok(existsSync(path.join(cwd, 'design/system.ad')));
```

Also assert that invalid module names create no directory, `.AD` is accepted without another suffix, an existing target is byte-for-byte preserved with exit code 1, and successful stdout reports the workspace-relative path.

**Step 3: Run the focused CLI tests and verify they fail**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/waveform-desktop
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/parserCompatibility.test.js packages/cli/dist-test/test/adCommand.test.js
```

Expected: failures report the unknown `ad new` action.

**Step 4: Implement the command**

Add `AD_NEW_HELP`, register `ad new` with positional `module` and `-o/--output`, and add `new` to `PARENT_ACTIONS.ad`. Implement:

```ts
export async function adNew(
    options: CommandOptions,
    environment: CommandEnvironment
): Promise<number> {
    const text = createEmptyArchDesignText(options.module!);
    const requested = options.output ?? `${options.module}.ad`;
    const output = requested.toLowerCase().endsWith('.ad')
        ? requested
        : `${requested}.ad`;
    const filepath = path.resolve(environment.cwd, output);
    await mkdir(path.dirname(filepath), { recursive: true });
    try {
        await writeFile(filepath, text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Arch Design already exists: ${displayPath(filepath, environment.cwd)}`);
        }
        throw error;
    }
    environment.stdout(`Arch Design created: ${displayPath(filepath, environment.cwd)}\n`);
    return 0;
}
```

Update root and AD help descriptions to include creation, then update the shared CLI contract snapshots that contain the root help text.

**Step 5: Run CLI tests and commit**

Run: `npm test --workspace @veriflow/cli`

Expected: all CLI tests pass.

```bash
git add packages/cli/src/main.ts packages/cli/src/commands/ad.ts packages/cli/test/parserCompatibility.test.ts packages/cli/test/adCommand.test.ts tests/cli_contract/cases.json docs/plans/2026-08-14-arch-design-creation-implementation.md
git commit -m "feat(cli): create Arch Design files"
```

### Task 3: Arch Designs Tree Provider

**Files:**
- Create: `veriflow-vscode/src/archDesign/archDesignTreeProvider.ts`
- Create: `veriflow-vscode/src/test/archDesignTreeProvider.test.ts`

**Step 1: Write the failing provider tests**

Use the repository's `Module._load` VS Code stubbing pattern to provide minimal `TreeItem`, `ThemeIcon`, `EventEmitter`, `Uri`, and `TreeItemCollapsibleState` fakes. Inject file discovery and relative-path functions, then assert:

```ts
const provider = new ArchDesignTreeProvider({
    findFiles: async () => [uri('z/top.ad'), uri('a/sub/system.ad')],
    asRelativePath: value => value.path,
});
const items = await provider.getChildren();
assert.deepEqual(items.map(item => item.label), ['system.ad', 'top.ad']);
assert.equal(items[0].contextValue, 'archDesignFile');
assert.equal(items[0].command?.command, 'veriflow.openArchDesign');
assert.deepEqual(items[0].command?.arguments, [items[0].resourceUri]);
```

Also assert stable code-unit ordering, directory descriptions, empty results, and that `refresh()` emits one root invalidation.

**Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run compile:ts --workspace veriflow
node veriflow-vscode/out/test/archDesignTreeProvider.test.js
```

Expected: compilation fails because the provider module does not exist.

**Step 3: Implement the provider**

Define a small injectable host with production defaults:

```ts
export type ArchDesignTreeHost = Readonly<{
    findFiles(): Thenable<vscode.Uri[]>;
    asRelativePath(uri: vscode.Uri): string;
}>;
```

`getChildren()` calls `vscode.workspace.findFiles('**/*.ad')`, sorts by `asRelativePath` using code-unit comparison, and returns leaf items with a circuit-board icon, resource URI, `archDesignFile` context value, relative parent description, and `veriflow.openArchDesign` command. `refresh()` fires `undefined` through the provider event emitter.

**Step 4: Run the provider test**

Run the focused command from Step 2.

Expected: the new provider test passes.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/archDesign/archDesignTreeProvider.ts veriflow-vscode/src/test/archDesignTreeProvider.test.ts
git commit -m "feat(vscode): list Arch Design files"
```

### Task 4: Testable VS Code Creation Workflow

**Files:**
- Create: `veriflow-vscode/src/archDesign/archDesignCreation.ts`
- Create: `veriflow-vscode/src/test/archDesignCreation.test.ts`
- Modify: `veriflow-vscode/src/extension.ts`
- Modify: `veriflow-vscode/src/test/hdlConfig.test.ts`
- Modify: `veriflow-vscode/src/test/extensionDependencyIndex.test.ts`
- Modify: `veriflow-vscode/src/test/hdlFeatureMigration.test.ts`

**Step 1: Write failing creation-workflow tests**

Define a generic service boundary and test it without loading VS Code:

```ts
const result = await createArchDesign({
    requestModule: async validate => {
        assert.equal(validate('1bad'), 'Enter a valid Verilog module name');
        assert.equal(validate('soc_top'), undefined);
        return 'soc_top';
    },
    requestTarget: async module => `workspace/${module}.ad`,
    writeFile: async (target, text) => writes.push([target, text]),
    openEditor: async target => opened.push(target),
    reportError: async message => errors.push(message),
});
```

Assert canonical bytes, module-cancel and target-cancel no-ops, write-before-open ordering, and write failure reporting without opening.

**Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run compile:ts --workspace veriflow
node veriflow-vscode/out/test/archDesignCreation.test.js
```

Expected: compilation fails because the workflow module does not exist.

**Step 3: Implement the workflow module**

Use `createEmptyArchDesignText()` both for `validateInput` and final bytes. Keep VS Code-specific dialogs and URI handling outside the module:

```ts
export async function createArchDesign<Resource>(
    services: ArchDesignCreationServices<Resource>
): Promise<Resource | undefined> {
    const module = await services.requestModule(validateArchDesignModule);
    if (module === undefined) return undefined;
    const text = createEmptyArchDesignText(module);
    const target = await services.requestTarget(module);
    if (target === undefined) return undefined;
    try {
        await services.writeFile(target, text);
        await services.openEditor(target);
        return target;
    } catch (error) {
        await services.reportError(error instanceof Error ? error.message : String(error));
        return undefined;
    }
}
```

**Step 4: Wire creation and opening into extension activation**

In `extension.ts`:

- construct `ArchDesignTreeProvider` and `createTreeView('veriflow.archDesigns', ...)`;
- create a `**/*.ad` watcher and refresh on create, change, and delete;
- register `veriflow.createArchDesign`, `veriflow.refreshArchDesigns`, and `veriflow.openArchDesign`;
- adapt `showInputBox`, `showSaveDialog`, `workspace.fs.writeFile`, and `vscode.openWith` to the creation workflow;
- default the save URI to `<first-workspace>/<module>.ad` when a workspace exists;
- when tree validate/export receives a URI, open that URI with `ArchDesignEditorProvider.viewType` before invoking the provider action so unopened files work.

Update extension lifecycle stubs to supply the new tree provider dependency and any new VS Code API surface, keeping existing lifecycle tests focused on their original behavior.

**Step 5: Run VS Code unit tests and commit**

Run: `npm test --workspace veriflow`

Expected: all VS Code test files pass.

```bash
git add veriflow-vscode/src/archDesign/archDesignCreation.ts veriflow-vscode/src/archDesign/archDesignTreeProvider.ts veriflow-vscode/src/extension.ts veriflow-vscode/src/test/archDesignCreation.test.ts veriflow-vscode/src/test/hdlConfig.test.ts veriflow-vscode/src/test/extensionDependencyIndex.test.ts veriflow-vscode/src/test/hdlFeatureMigration.test.ts
git commit -m "feat(vscode): create Arch Designs from the workspace"
```

### Task 5: Views, Menus, Activation, and Duplicate Action Removal

**Files:**
- Modify: `veriflow-vscode/package.json`
- Modify: `veriflow-vscode/src/test/schematicManifest.test.ts`
- Modify: `veriflow-vscode/src/test/vsixPackaging.test.ts`

**Step 1: Write failing manifest assertions**

Assert that:

- `veriflow.modules` is named and contextually titled `Simulation`;
- `veriflow.archDesigns` appears between Simulation and Testbench Generator;
- activation includes the AD view/create command;
- Create and Refresh appear in the Arch Designs view title;
- Open, Validate, and Export appear for `viewItem == archDesignFile`;
- `viewsWelcome` links to `veriflow.createArchDesign` when the AD tree is empty;
- Validate and Export remain command contributions but are absent from `editor/title`;
- the packaged VSIX contains the same view and command contributions.

**Step 2: Run manifest tests and verify they fail**

Run:

```bash
npm run vscode:prepublish --workspace veriflow
node veriflow-vscode/out/test/schematicManifest.test.js
```

Expected: assertions fail because the Arch Designs view and commands are not contributed and duplicate title actions still exist.

**Step 3: Update the manifest**

Add commands with Codicons:

```json
{ "command": "veriflow.createArchDesign", "title": "Create Arch Design", "category": "VeriFlow", "icon": "$(new-file)" },
{ "command": "veriflow.refreshArchDesigns", "title": "Refresh Arch Designs", "category": "VeriFlow", "icon": "$(refresh)" },
{ "command": "veriflow.openArchDesign", "title": "Open Arch Design", "category": "VeriFlow", "icon": "$(go-to-file)" }
```

Contribute the new view, `viewsWelcome`, view-title actions, and item-context actions. Remove only the AD Validate/Export entries from `editor/title`; retain the HDL schematic title command and retain Validate/Export in `contributes.commands`.

**Step 4: Run VS Code tests**

Run: `npm test --workspace veriflow`

Expected: all VS Code tests and packaging checks pass.

**Step 5: Commit**

```bash
git add veriflow-vscode/package.json veriflow-vscode/src/test/schematicManifest.test.ts veriflow-vscode/src/test/vsixPackaging.test.ts
git commit -m "feat(vscode): expose Arch Design workspace actions"
```

### Task 6: User Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `veriflow-vscode/README.md`
- Modify: `veriflow-vscode/README_zh-CN.md`

**Step 1: Update documentation**

In the Chinese repository README:

- add `veriflow ad new soc_top -o design/soc.ad` before validate/export examples;
- replace the hand-written JSON template with the `Arch Designs` create workflow;
- describe `Simulation` as the HDL workflow view;
- describe live E/W validation and the single in-editor Export RTL button.

Apply equivalent concise changes to both extension README languages. Correct the stale drag-to-connect text to the current two-click connection behavior while touching the AD workflow section.

**Step 2: Verify generated files and formatting**

Run:

```bash
git diff --check
npm run verify:generated
```

Expected: no whitespace errors and generated artifacts are current.

**Step 3: Run focused product suites**

Run:

```bash
npm test --workspace @veriflow/schematic-core
npm test --workspace @veriflow/cli
npm test --workspace veriflow
```

Expected: all suites pass; the optional Icarus test may skip when `iverilog` is unavailable.

**Step 4: Run the full workspace regression suite**

Run: `npm test`

Expected: exit code 0 across all Node workspaces and Electron interaction tests, with no Python tests.

**Step 5: Commit documentation**

```bash
git add README.md veriflow-vscode/README.md veriflow-vscode/README_zh-CN.md
git commit -m "docs(ad): document creation workflows"
```

**Step 6: Review branch scope**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
```

Expected: clean worktree, only the planned AD creation/navigation changes, and no generated build outputs.

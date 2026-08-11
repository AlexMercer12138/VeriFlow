# Arch Design CLI Validation And Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add explicit `veriflow ad validate` and failure-safe `veriflow ad export` commands over the shared Arch Design core.

**Architecture:** Extend the existing CLI parser with ordered positional arguments and option choices, then add a thin AD command adapter over `NodeWorkspaceHost` and `@veriflow/schematic-core/arch-design`. Keep semantic rules in the shared core and isolate local atomic publication in one testable Node runtime helper that never overwrites unmarked RTL.

**Tech Stack:** TypeScript 5.9, Node.js 24 filesystem promises, Node test runner, npm workspaces, shared tree-sitter HDL runtime.

---

## Scope Boundary

This plan implements only explicit validation and export. It does not add
build/simulation stale-output handling, VS Code `.ad` editing or export
commands, project schema changes, protocol interfaces, Python source, or Python
tests. Follow `@superpowers:test-driven-development` for every behavior change
and `@superpowers:verification-before-completion` before every completion claim.

Use this focused compile prefix after changing CLI TypeScript:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
```

### Task 1: Add The AD Command Grammar

**Files:**
- Modify: `packages/cli/src/main.ts`
- Create: `packages/cli/src/commands/ad.ts`
- Modify: `packages/cli/test/parserCompatibility.test.ts`
- Modify: `tests/cli_contract/cases.json`

**Step 1: Write failing parser tests**

Add focused cases to `parserCompatibility.test.ts` for:

```ts
assert.equal((await invoke(['ad', '--help'], cwd)).stdout, AD_PARENT_HELP);
assert.equal((await invoke(['ad', 'validate'], cwd)).exitCode, 2);
assert.match(
    (await invoke(['ad', 'export', 'soc.ad', '--language', 'vhdl'], cwd)).stderr,
    /invalid choice: 'vhdl' \(choose from verilog, systemverilog\)/
);
assert.equal(
    (await invoke(['ad', 'export', '--language', 'verilog'], cwd)).exitCode,
    2
);
```

Require missing positional errors to name `DESIGN`. Require `ad --help` to
list `validate` and `export`, and each leaf help to show the positional design
path and only its supported options.

Update the existing root-help and unknown-command expected strings in
`tests/cli_contract/cases.json` to include exactly one new parent command:

```text
ad           validate and export Arch Designs
```

Do not add AD execution cases to the legacy contract JSON; focused TypeScript
tests own the new command behavior, while all 85 compatibility cases remain
the regression boundary for old commands.

**Step 2: Run the parser test and verify RED**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/parserCompatibility.test.js
```

Expected: FAIL because `ad` is not a known parent and leaf commands have no
positional or choice metadata.

**Step 3: Extend the parser minimally**

Add command metadata without changing existing option behavior:

```ts
interface PositionalDefinition {
    key: string;
    requiredName: string;
}

interface OptionDefinition {
    key: string;
    aliases: string[];
    requiredName?: string;
    choices?: readonly string[];
}

interface LeafCommand {
    help: string;
    positionals?: readonly PositionalDefinition[];
    options: OptionDefinition[];
    handler: CommandHandler;
}
```

In `parseOptions()`, consume a non-option token as the next positional before
reporting it as unrecognized. Preserve option parsing before and after the
positional. Reject extra positionals through the existing parse-error format.
After obtaining an option value, reject a value outside `choices` with exit
code 2. Then check required positionals and required options together.

Register `ad` in `PARENT_HELP` and `PARENT_ACTIONS`, and register these leaves:

```ts
'ad validate': {
    help: AD_VALIDATE_HELP,
    positionals: [{ key: 'design', requiredName: 'DESIGN' }],
    options: [projectOption, libOption],
    handler: validateArchDesignCommand,
},
'ad export': {
    help: AD_EXPORT_HELP,
    positionals: [{ key: 'design', requiredName: 'DESIGN' }],
    options: [projectOption, libOption, outputOption, languageOption],
    handler: exportArchDesignCommand,
},
```

Create temporary command handlers in `commands/ad.ts` that throw a clear
`Arch Design command is not implemented` error if invoked. Parser/help tests
must not call the placeholder because later tasks replace it immediately.

**Step 4: Run parser and compatibility tests and verify GREEN**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/parserCompatibility.test.js packages/cli/dist-test/test/cliContract.test.js
```

Expected: parser tests pass and all 85 legacy CLI cases pass with only the
intentional root-help text change.

**Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/commands/ad.ts \
  packages/cli/test/parserCompatibility.test.ts tests/cli_contract/cases.json
git commit -m "feat(cli): add Arch Design command grammar"
```

### Task 2: Validate Standalone Arch Designs

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `package-lock.json`
- Modify: `packages/cli/src/commands/ad.ts`
- Create: `packages/cli/test/adCommand.test.ts`

**Step 1: Write failing standalone validation tests**

Build a temporary fixture with `design/soc.ad` and `design/leaf.sv`. Use a
minimal schema-v1 design that instantiates `leaf`, and assert:

```ts
const result = await invoke(['ad', 'validate', 'design/soc.ad'], fixture);
assert.deepEqual(result, {
    exitCode: 0,
    stdout: 'Arch Design: OK\n',
    stderr: '',
});
```

Add exact failure tests for:

- a missing `.ad` file;
- invalid JSON with `AD_JSON_SYNTAX` at `$`;
- schema version 2 with `AD_SCHEMA_UNSUPPORTED` at `$.schemaVersion`;
- an unresolved instance with `AD_MODULE_UNRESOLVED` at
  `$.instances[0].module`;
- duplicate module definitions with `AD_MODULE_AMBIGUOUS`;
- a semantic port error from the shared resolver.

Diagnostics must use one line per core diagnostic:

```text
design/soc.ad:$.instances[0].module [AD_MODULE_UNRESOLVED] No module definition is named leaf
```

For display, normalize separators to `/`. Show a path relative to `cwd` when
the resolved file is inside `cwd`; otherwise show the absolute resolved path.
Use the same rule for the design prefix and the successful output path.

Failures produce no stdout, write diagnostics to stderr, and return 1.

**Step 2: Run the AD test and verify RED**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/adCommand.test.js
```

Expected: FAIL because the command handler is still a placeholder.

**Step 3: Add the package dependency**

Add the workspace-version dependency:

```json
"@veriflow/schematic-core": "1.4.0"
```

Update only lock metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

Confirm the `packages/cli` lock entry contains the same exact version.

**Step 4: Implement the shared preparation path**

In `commands/ad.ts`, add private helpers that:

1. resolve `options.design` from `environment.cwd`;
2. read UTF-8 text and call `parseArchDesign()`;
3. print invalid parser diagnostics without scanning HDL;
4. convert an unsupported result into this CLI diagnostic:

```ts
{
    path: '$.schemaVersion',
    code: 'AD_SCHEMA_UNSUPPORTED',
    message: `Arch Design schema version ${result.schemaVersion} is not supported`,
}
```

5. collect standalone search roots from the design directory, global library
   configuration, and `-L/--lib`;
6. scan them through `NodeWorkspaceHost`;
7. read `host.index.getAllDefinitions('module')` as the stable catalog;
8. install and remove one SIGINT abort listener around the scan;
9. always dispose the host in `finally`.

Resolve global and command-line library paths from `environment.cwd`, filter
nonexistent/non-directory inputs, and deduplicate resolved paths in declared
precedence. Do not read output settings during validation.

Implement `validateArchDesignCommand()` by calling `validateArchDesign()` once
with the prepared design and catalog. Preserve diagnostic order. Do not write
the project, global config, `.ad`, or RTL files.

**Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/adCommand.test.js packages/cli/dist-test/test/parserCompatibility.test.js
```

Expected: standalone validation, invalid input, unsupported schema, and
semantic diagnostic tests pass.

**Step 6: Commit**

```bash
git add packages/cli/package.json package-lock.json \
  packages/cli/src/commands/ad.ts packages/cli/test/adCommand.test.ts
git commit -m "feat(cli): validate standalone Arch Designs"
```

### Task 3: Resolve Project And Library Catalogs Without Mutation

**Files:**
- Modify: `packages/cli/src/commands/ad.ts`
- Modify: `packages/cli/test/adCommand.test.ts`

**Step 1: Write failing catalog-scope tests**

Create one design with four instances whose modules live in:

- the project root;
- a project library;
- a global library listed in `<home>/.veriflow_config.json`;
- an extra directory passed through comma-separated `-L`.

Place the `.ad` outside the project root and invoke:

```ts
await invoke([
    'ad', 'validate', 'design/soc.ad',
    '--project', 'project.json',
    '--lib', 'extra-a,extra-b',
], fixture);
```

Assert validation succeeds, all relative inputs resolve from `cwd`, and the
project file bytes are unchanged. Add a module beside the `.ad` that is needed
only by a second design; with `--project`, assert that module is unresolved so
the source directory is not silently added to project mode.

Also test:

- a missing project path produces exit code 1 and no scan output;
- nonexistent library directories are ignored;
- repeated and overlapping roots do not create duplicate module definitions;
- standalone mode still includes the source directory, globals, and `-L`.

**Step 2: Run the focused test and verify RED**

Run the focused compile prefix, then:

```bash
node --test packages/cli/dist-test/test/adCommand.test.js
```

Expected: at least the project-root and project-immutability assertions fail.

**Step 3: Implement the two search modes**

When `options.project` is present, open it with `ProjectStore` and select roots
in this exact order:

```ts
[
    project.rootDir,
    ...project.libDirs,
    ...globalLibraries,
    ...commandLineLibraries,
]
```

Otherwise select:

```ts
[
    path.dirname(designPath),
    ...globalLibraries,
    ...commandLineLibraries,
]
```

Share the existing-directory and deduplication helper between modes. Never call
`ProjectStore.save()` or any global-config mutation method. Keep the catalog
as all indexed modules rather than resolving only currently referenced names,
so duplicate-name diagnostics remain owned by the shared resolver.

**Step 4: Run focused and CLI tests and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/cli
```

Expected: all original 85 CLI cases plus the new AD tests pass.

**Step 5: Commit**

```bash
git add packages/cli/src/commands/ad.ts packages/cli/test/adCommand.test.ts
git commit -m "feat(cli): resolve Arch Design module catalogs"
```

### Task 4: Publish Generated Files Atomically

**Files:**
- Create: `packages/cli/src/runtime/atomicGeneratedFile.ts`
- Create: `packages/cli/test/atomicGeneratedFile.test.ts`

**Step 1: Write failing publication tests**

Test `publishGeneratedFileAtomic(targetPath, text)` with real temporary
directories and a narrow injectable operations object. Cover:

1. an absent target receives complete bytes and leaves no temporary name;
2. a target containing a valid `exportArchDesignRtl()` marker is replaced;
3. hand-written RTL is refused before any temporary write;
4. a malformed or non-leading marker is refused;
5. a target created between initial inspection and publication is preserved;
6. a temporary write failure leaves an existing generated target byte-identical;
7. a target changed to hand-written text before the ownership recheck is
   preserved;
8. a rename failure leaves the existing generated target byte-identical;
9. every failure removes the helper's temporary file.

Use an operations shape limited to this helper, for example:

```ts
export type AtomicGeneratedFileOperations = Readonly<{
    readFile(filepath: string): Promise<string>;
    makeDirectory(directory: string): Promise<void>;
    writeTemporary(filepath: string, text: string): Promise<void>;
    link(source: string, target: string): Promise<void>;
    rename(source: string, target: string): Promise<void>;
    remove(filepath: string): Promise<void>;
}>;
```

Tests may wrap the real operations to inject a concurrent create or a single
method failure. Do not mock the shared marker parser.

**Step 2: Run the atomic test and verify RED**

Run the focused compile prefix, then:

```bash
node --test packages/cli/dist-test/test/atomicGeneratedFile.test.js
```

Expected: compilation fails because the runtime helper is absent.

**Step 3: Implement the Node operations**

Create a unique same-directory temporary path using the target basename,
`process.pid`, and cryptographic random bytes. The production
`writeTemporary()` must:

```ts
const handle = await open(temporaryPath, 'wx');
try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
} finally {
    await handle.close();
}
```

Before creating a temporary file, read the target. Treat only `ENOENT` as
absent. If present, require `parseArchDesignRtlMarker(existing)`.

After the temporary file is complete:

- For an initially absent target, call `link(temp, target)` so a concurrent
  target produces `EEXIST` instead of being overwritten, then remove temp.
- For an initially generated target, read it again. If now absent, use the
  no-clobber link path. If present without a valid marker, refuse. If still
  generated, call same-directory `rename(temp, target)` for atomic replacement.

Run cleanup in `finally` without hiding the primary error. Export a specific
conflict error class so the command can report a concise ownership message.
Do not provide a force parameter.

**Step 4: Run the atomic tests and verify GREEN**

Run:

```bash
npm run build:shared
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/atomicGeneratedFile.test.js
```

Expected: all creation, replacement, conflict, injected failure, and cleanup
tests pass on the current platform.

**Step 5: Commit**

```bash
git add packages/cli/src/runtime/atomicGeneratedFile.ts \
  packages/cli/test/atomicGeneratedFile.test.ts
git commit -m "feat(cli): publish generated RTL atomically"
```

### Task 5: Export Verilog And SystemVerilog Through The CLI

**Files:**
- Modify: `packages/cli/src/commands/ad.ts`
- Modify: `packages/cli/test/adCommand.test.ts`
- Modify: `packages/cli/test/atomicGeneratedFile.test.ts`

**Step 1: Write failing export workflow tests**

Add end-to-end CLI tests for:

- default sibling `soc.v` output;
- design-level `export.output` relative to the `.ad` directory;
- `-o/--output` relative to `cwd` and taking precedence over the design;
- default Verilog and explicit `--language systemverilog` `.sv` output;
- CLI language taking precedence over `design.export.language`;
- case-insensitive matching `.v` and `.sv` extensions;
- rejecting a mismatched or missing output extension before directory creation;
- invalid semantics leaving a prior generated target byte-identical;
- replacing a valid prior generated file;
- refusing hand-written and malformed-marker targets;
- creating a missing explicit output parent directory;
- output containing the source comment, generation marker, instance, and
  explicit named port mappings from the real scanned module summary.

Parse the generated marker with the shared public API in the test. Do not copy
the marker regular expression into CLI tests.

**Step 2: Run the AD test and verify RED**

Run the focused compile prefix, then:

```bash
node --test packages/cli/dist-test/test/adCommand.test.js
```

Expected: export cases fail because the handler remains a placeholder.

**Step 3: Resolve language and output deterministically**

Compute effective language with this precedence:

```ts
const language = options.language as ArchDesignLanguage | undefined
    ?? design.export.language
    ?? 'verilog';
```

The parser choice metadata already rejects other CLI values. Select the output
path with this precedence:

```text
CLI output (relative to cwd)
  > design export.output (relative to design directory)
  > source basename with the effective extension
```

Require `path.extname(output).toLowerCase()` to equal `.v` for Verilog or `.sv`
for SystemVerilog. Do not infer language from the filename. Resolve the path
before generating, but do not create its parent directory until generation has
succeeded.

Pass a portable source comment path to the core: prefer the path from the
output directory to the `.ad` file, normalize separators to `/`, and fall back
to the absolute source path when the platform cannot express a relative path.
The source comment must not participate in the fingerprint.

**Step 4: Generate once and publish once**

Call:

```ts
const generated = exportArchDesignRtl(design, definitions, {
    language,
    sourcePath,
});
```

If invalid, print its diagnostics and return 1 without touching the output
directory. If generated, call `publishGeneratedFileAtomic()` exactly once.
On success print one stable line:

```text
RTL exported: <output-path>
```

Format `<output-path>` through the Task 2 display rule: `/` separators,
cwd-relative only when the resolved target is inside `cwd`, otherwise absolute.
Map ownership conflicts and filesystem errors through the normal CLI exception
boundary. Never print generated RTL to stdout and never rewrite `.ad`.

**Step 5: Run focused and package tests and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/cli
npm test --workspace @veriflow/schematic-core
```

Expected: all CLI tests pass; schematic-core remains 290 passes with the one
environmental Icarus skip when `iverilog` is unavailable.

**Step 6: Commit**

```bash
git add packages/cli/src/commands/ad.ts packages/cli/test/adCommand.test.ts \
  packages/cli/test/atomicGeneratedFile.test.ts
git commit -m "feat(cli): export Arch Design RTL"
```

### Task 6: Verify Published CLI Behavior And Document Usage

**Files:**
- Modify: `scripts/test-node-release.mjs`
- Modify: `README.md`
- Review: `packages/cli/package.json`
- Review: `package-lock.json`

**Step 1: Add a clean-install release smoke assertion**

Extend the clean-installed CLI smoke project with a minimal `soc.ad` that
instantiates the existing `child` module. Invoke the packed CLI twice:

```js
const validateAd = invokeCli(['ad', 'validate', 'soc.ad'], projectRoot, environment);
assert.equal(validateAd.status, 0, validateAd.stderr);

const exportAd = invokeCli(['ad', 'export', 'soc.ad'], projectRoot, environment);
assert.equal(exportAd.status, 0, exportAd.stderr);
assert.match(readFileSync(path.join(projectRoot, 'soc.v'), 'utf8'),
    /^\/\/ vik-veriflow:generated arch-design /);
```

Require the installed CLI package manifest to depend on the published
`@veriflow/schematic-core` version.

**Step 2: Run release smoke and expose any packaging gap**

Run:

```bash
npm run test:release
```

Expected: PASS when the dependency and package exports from earlier tasks are
complete. If the clean-installed CLI cannot resolve the Arch Design subpath or
parser assets, keep the failing assertion as evidence and make only the
packaging fix required by that failure.

**Step 3: Apply only required packaging fixes**

Keep `@veriflow/schematic-core` as a normal exact-version CLI dependency. Do
not bundle duplicate core code into CLI `dist`, add Python artifacts, or expose
internal source paths. Confirm the release pack list already installs the
schematic-core tarball before the CLI tarball; change scripts only if the new
smoke proves a real omission.

**Step 4: Update the Chinese README concisely**

Add Arch Design to the feature list and one compact usage block:

```bash
veriflow ad validate design/soc.ad
veriflow ad export design/soc.ad
veriflow ad export design/soc.ad --language systemverilog -o generated/soc.sv
```

State that default output is sibling `.v`, `.ad` is the source of truth, and
only VeriFlow-marked generated files are replaceable. Do not add implementation
architecture or a long schema tutorial.

**Step 5: Run focused release and package verification**

Run:

```bash
npm run test:release
npm pack --dry-run --workspace @veriflow/cli --json
npm pack --dry-run --workspace @veriflow/schematic-core --json
npm run verify:generated
```

Expected: release smoke validates and exports through the clean-installed CLI;
the CLI package contains `dist/commands/ad.js` and
`dist/runtime/atomicGeneratedFile.js`; schematic-core still contains its
`dist/archDesign` public subpath; generated assets are synchronized.

**Step 6: Run the complete regression gate**

Run:

```bash
xvfb-run -a npm test
git diff --check main..HEAD
git status --short --branch
```

Expected:

- existing 85 CLI cases and all new AD tests pass;
- shared packages, Electron, VS Code 33 test entry points, and VSIX packaging
  pass;
- the only Icarus skip is explicit when `iverilog` is unavailable;
- no Python command or test is run;
- no unintended generated or temporary file remains.

**Step 7: Review scope and commit**

Inspect:

```bash
git diff --stat main..HEAD
git diff main..HEAD
```

Confirm there is no build/simulation auto-export, VS Code editor change,
project schema mutation, interface implementation, generic filesystem service,
or force-overwrite option.

Commit the final release/docs changes:

```bash
git add scripts/test-node-release.mjs README.md
git commit -m "test: verify published Arch Design CLI workflow"
```

Then use `@superpowers:requesting-code-review`,
`@superpowers:verification-before-completion`, and
`@superpowers:finishing-a-development-branch` before integration.

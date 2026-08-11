# Arch Design Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the first editable `.ad` document foundation: a versioned immutable model, safe parsing, deterministic serialization, and a semantic fingerprint that ignores presentation-only edits.

**Architecture:** Keep all document rules in a new host-neutral `archDesign` area of `@veriflow/schematic-core`. Parse untrusted JSON into owned, deeply frozen schema-v1 values and return discriminated read results so VS Code can open unknown future versions read-only. Serialize only the normalized public model in a fixed field order; compute a deterministic non-cryptographic content fingerprint from the semantic fields while excluding `presentation`.

**Tech Stack:** TypeScript 5.9, Node test runner, JSON, existing `@veriflow/schematic-core` workspace package.

---

## Scope Boundary

This batch establishes the document contract used by later validation, RTL
export, Node CLI commands, and the `.ad` custom editor. It deliberately does
not yet resolve HDL module definitions, validate electrical connectivity,
generate RTL, register VS Code commands, or render editable controls.

The schema represents those future operations now so subsequent phases do not
need a format-breaking rewrite:

- top-level input, output, and inout ports;
- module instances and parameter overrides;
- scalar network endpoint lists and per-receiver default overrides;
- master-to-slave interface connections and member defaults;
- export language/output preferences;
- node placement, collapsed-interface, and viewport presentation state.

No new runtime dependency and no Python source or Python test path is added.

### Task 1: Add the Versioned Arch Design Model

**Files:**
- Create: `packages/schematic-core/src/archDesign/model.ts`
- Create: `packages/schematic-core/src/archDesign/index.ts`
- Create: `packages/schematic-core/test/archDesignModel.test.ts`
- Modify: `packages/schematic-core/src/index.ts`

**Step 1: Write the failing public model tests**

Add tests that import the future public API, create an empty design, and type a
representative complete design:

```ts
import {
    ARCH_DESIGN_FORMAT,
    ARCH_DESIGN_SCHEMA_VERSION,
    createEmptyArchDesign,
    type ArchDesign,
} from '../src';

test('creates a minimal schema-v1 Arch Design', () => {
    const design = createEmptyArchDesign('soc_top');
    assert.deepEqual(design, {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc_top',
        ports: [],
        instances: [],
        connections: [],
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
    });
    assert.equal(ARCH_DESIGN_FORMAT, design.format);
    assert.equal(ARCH_DESIGN_SCHEMA_VERSION, design.schemaVersion);
    assert.ok(Object.isFrozen(design));
});
```

The representative typed value must cover numeric and expression widths,
input/output/inout ports, instance parameter values, top-level and instance
connection endpoints, endpoint defaults, interface endpoints, Verilog export,
semantic placement, collapsed interfaces, and viewport state.

Require `createEmptyArchDesign` to reject empty or invalid Verilog identifiers
instead of creating an unusable document.

**Step 2: Run the focused test and verify RED**

Run:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: TypeScript compilation fails because the Arch Design API does not
exist.

**Step 3: Implement the minimal immutable model**

Define these public constants and model families:

```ts
export const ARCH_DESIGN_FORMAT = 'vik-veriflow.arch-design' as const;
export const ARCH_DESIGN_SCHEMA_VERSION = 1 as const;

export type ArchDesignWidth = number | Readonly<{ expression: string }>;
export type ArchDesignParameterValue = string | number | boolean;
export type ArchDesignPortDirection = 'input' | 'output' | 'inout';
export type ArchDesignLanguage = 'verilog' | 'systemverilog';
```

Use discriminated scalar endpoints:

```ts
export type ArchDesignEndpoint =
    | Readonly<{ kind: 'port'; port: string; signal?: 'value' | 'i' | 'o' | 't' }>
    | Readonly<{ kind: 'instance'; instance: string; port: string }>;
```

Model defaults as string expressions keyed by receiver endpoint
(`instance.port` or `port.signal`). Model interface connections with one master
and one slave endpoint, an optional protocol name, and optional member-default
overrides. Model presentation as optional node placements, collapsed-interface
flags, and viewport state.

`createEmptyArchDesign(module)` must validate a plain Verilog identifier,
construct all required top-level collections, and deeply freeze its output.
Keep the freeze helper private to the Arch Design implementation.

**Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: all schematic-core tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/src/index.ts \
  packages/schematic-core/test/archDesignModel.test.ts
git commit -m "feat: define Arch Design document model"
```

### Task 2: Parse Untrusted `.ad` JSON Safely

**Files:**
- Create: `packages/schematic-core/src/archDesign/parser.ts`
- Create: `packages/schematic-core/test/archDesignParser.test.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`

**Step 1: Write failing parser contract tests**

Define the desired result API through tests:

```ts
const result = parseArchDesignText(validSource);
assert.equal(result.status, 'editable');
if (result.status !== 'editable') return;
assert.equal(result.design.module, 'soc_top');
assert.ok(Object.isFrozen(result.design.connections));
```

Cover these distinct outcomes:

- valid schema-v1 JSON returns `status: 'editable'` with an owned, deeply
  frozen normalized design;
- invalid JSON returns `status: 'invalid'` with a `$` diagnostic;
- wrong `format` returns `status: 'invalid'`;
- a positive integer schema version other than 1 returns
  `status: 'unsupported'`, preserving the parsed version and source value for
  a future read-only editor;
- malformed current-version fields return all deterministic path-addressed
  diagnostics rather than throwing on the first field;
- duplicate port, instance, connection, and interface-connection names are
  rejected structurally;
- inherited properties and `__proto__` object keys are never treated as schema
  fields;
- mutating the original parsed object after `parseArchDesignValue` does not
  change the normalized result.

**Step 2: Run the focused parser test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignParser.test.js
```

Expected: compilation fails because `parseArchDesignText` and
`parseArchDesignValue` are missing.

**Step 3: Implement normalization and diagnostics**

Add discriminated read results:

```ts
export type ArchDesignReadResult =
    | Readonly<{ status: 'editable'; design: ArchDesign }>
    | Readonly<{
        status: 'unsupported';
        schemaVersion: number;
        value: Readonly<Record<string, unknown>>;
    }>
    | Readonly<{ status: 'invalid'; diagnostics: readonly ArchDesignDiagnostic[] }>;
```

Each diagnostic contains a JSON-style `path`, stable `code`, and user-facing
`message`. Use small explicit normalizers rather than a new validation library.
Read every accepted value once, copy only own enumerable properties into
prototype-free dictionaries, keep array declaration order, collect field
errors deterministically, and freeze all returned arrays and records.

The parser performs document-shape validation only. It must not resolve module
names, check endpoint existence, infer widths, or judge electrical roles; those
belong to the semantic validator phase.

**Step 4: Run parser and complete core tests and verify GREEN**

Run:

```bash
node --test packages/schematic-core/dist-test/test/archDesignParser.test.js
npm test --workspace @veriflow/schematic-core
```

Expected: parser tests and all existing core tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignParser.test.ts
git commit -m "feat: parse versioned Arch Design documents"
```

### Task 3: Add Deterministic Serialization and Semantic Fingerprints

**Files:**
- Create: `packages/schematic-core/src/archDesign/serializer.ts`
- Create: `packages/schematic-core/src/archDesign/fingerprint.ts`
- Create: `packages/schematic-core/test/archDesignSerialization.test.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`

**Step 1: Write failing round-trip and fingerprint tests**

Test the exact serialized field order and two-space JSON formatting:

```ts
const source = serializeArchDesign(design);
assert.equal(source.endsWith('\n'), true);
const reparsed = parseArchDesignText(source);
assert.equal(reparsed.status, 'editable');
if (reparsed.status === 'editable') assert.deepEqual(reparsed.design, design);
```

Require deterministic output for equivalent parameter/default dictionaries
created in different insertion orders. Preserve declaration order for ports,
instances, scalar connections, interface connections, and connection
endpoints.

Fingerprint tests require:

```ts
assert.equal(
    semanticArchDesignFingerprint(withMovedPresentation),
    semanticArchDesignFingerprint(original)
);
assert.notEqual(
    semanticArchDesignFingerprint(withChangedConnection),
    semanticArchDesignFingerprint(original)
);
```

Also require the prefix `ad-v1-`, stability across parse/serialize round trips,
and sensitivity to ports, instances, parameters, defaults, interface
connections, and export language. Output-path-only and all `presentation`
changes must not stale generated RTL.

**Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignSerialization.test.js
```

Expected: compilation fails because serialization and fingerprint functions do
not exist.

**Step 3: Implement canonical serialization**

Build a plain serializable object in the public schema's fixed top-level and
nested key order. Sort only dictionary keys such as parameters and defaults;
never sort declaration-order arrays. Omit optional fields when absent. Return
`JSON.stringify(value, null, 2) + '\n'`.

**Step 4: Implement the semantic projection and fingerprint**

Construct the fingerprint input from:

```text
format, schemaVersion, module, ports, instances, connections,
interfaceConnections, defaults, export.language
```

Exclude `presentation` and `export.output`. Feed the canonical semantic JSON
through a small pure-TypeScript 64-bit FNV-1a implementation and return a fixed
16-digit lowercase hexadecimal string prefixed with `ad-v1-`. This is a stale
output cache key, not a cryptographic signature.

**Step 5: Run focused and complete core tests and verify GREEN**

Run:

```bash
node --test packages/schematic-core/dist-test/test/archDesignSerialization.test.js
npm test --workspace @veriflow/schematic-core
```

Expected: all serialization, fingerprint, parser, and existing schematic tests
pass.

**Step 6: Commit**

```bash
git add packages/schematic-core/src/archDesign \
  packages/schematic-core/test/archDesignSerialization.test.ts
git commit -m "feat: serialize Arch Designs deterministically"
```

### Task 4: Verify the Shared Package Boundary

**Files:**
- Modify if required: `packages/flow-core/test/importPolicy.test.ts`
- Modify if required: `packages/schematic-core/package.json`

**Step 1: Run the shared import-policy tests**

Run:

```bash
npm test --workspace @veriflow/flow-core
```

Expected: PASS and no Arch Design source imports VS Code, Electron, DOM, Node
filesystem, or a product entry point.

**Step 2: Run the complete Node/TypeScript suite**

Run:

```bash
xvfb-run -a npm test
npm run verify:generated
```

Expected: every workspace test, Electron schematic test, VSIX packaging test,
and generated-asset check passes. Do not run Python tests.

**Step 3: Inspect the worktree**

Run:

```bash
git status --short
git diff --check
```

Expected: only intentional Arch Design source, tests, and this plan are
present, with no whitespace errors or generated build output.

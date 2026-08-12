# Arch Design Interface Protocols Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver JSON-defined interface recognition, collapsed authoring,
one-to-one connections, explicit defaults, top-level promotion, and RTL export
as one shared Arch Design workflow for Node CLI and VS Code.

**Architecture:** Add a host-neutral `@veriflow/schematic-core/interfaces`
subpath whose built-in JSON resources pass through the same defensive parser as
project files. Arch Design resolution consumes one immutable protocol catalog
and produces a single expanded member-binding model shared by validation,
graph projection, Inspector data, and RTL generation. Product hosts only read
protocol files and project configuration; the webview renders resolved models
and sends typed edits.

**Tech Stack:** TypeScript 5.9, Node test runner, JSON protocol resources,
existing HDL workspace index, X6 schematic webview, Electron/Playwright tests,
VS Code custom text editor, npm workspaces.

---

## Working Rules

- Follow `@superpowers:test-driven-development` for every behavior change.
- Keep protocol parsing, recognition, expansion, and defaults host-neutral.
- Do not add AXI/APB/AHB branches outside protocol JSON fixtures.
- Protocols contain no width declarations. Instance widths come from HDL;
  promoted top-level interfaces persist actual member-width snapshots.
- Preserve the scalar editor and read-only HDL schematic behavior throughout.
- Commit after every task once its focused tests pass.

### Task 1: Define And Defensively Parse Protocol JSON

**Files:**
- Create: `packages/schematic-core/src/interfaces/model.ts`
- Create: `packages/schematic-core/src/interfaces/parser.ts`
- Create: `packages/schematic-core/src/interfaces/index.ts`
- Create: `packages/schematic-core/test/interfaceProtocolParser.test.ts`
- Modify: `packages/schematic-core/package.json`
- Modify: `packages/schematic-core/tsconfig.json`
- Modify: `packages/flow-core/test/boundaries.test.ts`

**Step 1: Write the failing parser and public-boundary tests**

Cover a complete protocol, unknown schema versions, non-plain objects, getter
and prototype-hostile values, duplicate case-insensitive member names, invalid
separators, invalid priorities, empty/unknown recognition members, duplicate
recognition groups, unsafe defaults, and detached deeply frozen results.

The public model begins with:

```ts
export type InterfaceMemberDirection = 'master-to-slave' | 'slave-to-master';

export type InterfaceProtocolMember = Readonly<{
    name: string;
    direction: InterfaceMemberDirection;
    defaultExpression?: string;
}>;

export type InterfaceProtocol = Readonly<{
    format: 'veriflow-interface-protocol';
    schemaVersion: 1;
    id: string;
    name: string;
    separator: string;
    priority: number;
    members: readonly InterfaceProtocolMember[];
    recognitionGroups: readonly (readonly string[])[];
}>;
```

**Step 2: Run the focused tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/interfaceProtocolParser.test.js
```

Expected: compilation fails because the `interfaces` API does not exist.

**Step 3: Implement the immutable parser and subpath export**

Return discriminated `editable`, `unsupported`, and `invalid` results with
path-aware `IF_PROTOCOL_*` diagnostics. Reuse the Arch Design safe constant
expression validator through a local shared import, without introducing a
host dependency. Add `./interfaces` to `exports` and `typesVersions`.

**Step 4: Run focused and boundary tests**

```bash
npm test --workspace @veriflow/schematic-core
npm test --workspace @veriflow/flow-core
```

Expected: all tests pass and the import policy permits only local source plus
`@veriflow/hdl-core`.

**Step 5: Commit**

```bash
git add packages/schematic-core packages/flow-core/test/boundaries.test.ts
git commit -m "feat(schematic-core): parse interface protocols"
```

### Task 2: Ship Built-In Protocols Through The Same Parser

**Files:**
- Create: `packages/schematic-core/src/interfaces/builtins/axi4.json`
- Create: `packages/schematic-core/src/interfaces/builtins/axis.json`
- Create: `packages/schematic-core/src/interfaces/builtins/apb.json`
- Create: `packages/schematic-core/src/interfaces/builtins/ahb-lite.json`
- Create: `packages/schematic-core/src/interfaces/builtins.ts`
- Create: `packages/schematic-core/src/interfaces/catalog.ts`
- Create: `packages/schematic-core/test/interfaceProtocolCatalog.test.ts`
- Modify: `packages/schematic-core/src/interfaces/index.ts`
- Modify: `packages/schematic-core/package.json`
- Modify: `scripts/test-node-release.mjs`

**Step 1: Write failing catalog and package-content tests**

Assert that built-ins are parsed rather than asserted, IDs are stable
(`amba.axi4`, `amba.axis`, `amba.apb`, `amba.ahb-lite`), AXI4-Lite has no
separate definition, clock/reset members are absent, lookup order is stable,
and a valid project definition replaces a built-in by ID. An invalid project
definition must not partially replace it. Assert the npm tarball contains all
four JSON resources.

**Step 2: Run tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/interfaceProtocolCatalog.test.js
node scripts/test-node-release.mjs
```

Expected: built-in imports/catalog and packaged JSON assertions fail.

**Step 3: Add protocol resources and catalog construction**

Import every JSON resource with `resolveJsonModule` and pass it to
`parseInterfaceProtocolValue`. `createInterfaceProtocolCatalog(overrides)`
returns an immutable ordered catalog, effective-source provenance, and loader
diagnostics. Populate complete practical member lists and signature groups;
defaults remain conservative constant expressions and include `wlast=1'b1`
for incomplete AXI4 single-beat use. Every built-in default must compile as
Verilog-2001; use ordinary `0` for width-independent zero fill rather than the
SystemVerilog-only unbased literal `'0`.

**Step 4: Verify core and packed release**

```bash
npm test --workspace @veriflow/schematic-core
npm pack --dry-run --workspace @veriflow/schematic-core --json
node scripts/test-node-release.mjs
```

Expected: all tests pass and packed `dist/interfaces/builtins/*.json` files are
present.

**Step 5: Commit**

```bash
git add packages/schematic-core scripts/test-node-release.mjs
git commit -m "feat(schematic-core): ship built-in interface protocols"
```

### Task 3: Recognize Module Interfaces And Infer Roles

**Files:**
- Create: `packages/schematic-core/src/interfaces/recognition.ts`
- Create: `packages/schematic-core/test/interfaceRecognition.test.ts`
- Modify: `packages/schematic-core/src/interfaces/model.ts`
- Modify: `packages/schematic-core/src/interfaces/index.ts`

**Step 1: Write failing recognition tests**

Build catalog-port fixtures for two AXI interfaces on one module, uppercase and
lowercase names, protocol-specific separators, longest suffix collisions,
incomplete AXI4 signatures, ordinary `ready/data` ports below the signature
threshold, AXI versus AXI-Stream ambiguity, duplicate candidate members, and
stable declaration order. Verify roles use only actual HDL directions and
never `m_`/`s_` prefixes. Verify insufficient evidence yields `unknown`.

**Step 2: Run the focused test and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/interfaceRecognition.test.js
```

Expected: recognition exports are absent.

**Step 3: Implement deterministic recognition**

Normalize only for comparison, retain original interface and port spellings,
and index member suffixes by descending length. Group candidates by exact
prefix, require one complete signature, score protocol ties by signature
specificity, total matched members, then protocol priority, and diagnose an
exact tie. Infer role by comparing member direction with `input/output`; ignore
`inout` evidence.

**Step 4: Run focused and full core tests**

```bash
node --test packages/schematic-core/dist-test/test/interfaceRecognition.test.js
npm test --workspace @veriflow/schematic-core
```

Expected: all tests pass with deterministic frozen results.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/interfaces packages/schematic-core/test/interfaceRecognition.test.ts
git commit -m "feat(schematic-core): recognize protocol interfaces"
```

### Task 4: Extend The Arch Design Schema For Interface Intent

**Files:**
- Modify: `packages/schematic-core/src/archDesign/model.ts`
- Modify: `packages/schematic-core/src/archDesign/parser.ts`
- Modify: `packages/schematic-core/src/archDesign/serializer.ts`
- Modify: `packages/schematic-core/src/archDesign/fingerprint.ts`
- Modify: `packages/schematic-core/test/archDesignModel.test.ts`
- Modify: `packages/schematic-core/test/archDesignParser.test.ts`
- Modify: `packages/schematic-core/test/archDesignSerialization.test.ts`

**Step 1: Write failing schema round-trip tests**

Add fixtures for `interfacePorts`, `interfaceOverrides`, and instance/top-port
interface endpoints. A promoted member stores `{ member, width }`, where width
uses the existing known/symbolic Arch Design width representation. Verify
case-sensitive user keys, duplicate semantic names, malformed endpoint kinds,
unsafe defaults, dictionary ownership, deterministic ordering, semantic
fingerprints, and presentation exclusion.

Use the normalized surface:

```ts
type ArchDesignInterfacePort = Readonly<{
    name: string;
    protocol: string;
    role: 'master' | 'slave';
    memberPrefix: string;
    members: readonly Readonly<{ member: string; width: ArchDesignWidth }>[];
}>;

type ArchDesignInterfaceEndpoint =
    | Readonly<{ kind: 'instance'; instance: string; interface: string }>
    | Readonly<{ kind: 'port'; port: string }>;
```

`interfaceConnections.master/slave` identify effective roles inside the
design. A top-level Master has effective Slave behavior at the inner boundary;
a top-level Slave has effective Master behavior.

**Step 2: Run schema tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignModel.test.js \
  packages/schematic-core/dist-test/test/archDesignParser.test.js \
  packages/schematic-core/dist-test/test/archDesignSerialization.test.js
```

Expected: new fields and endpoint variants are rejected or absent.

**Step 3: Implement parsing, serialization, and fingerprinting**

Keep schema version 1 because the fields already existed as forward-planned
sections and no supported interface behavior has shipped. Normalize old files
with missing sections to empty collections. Snapshot all caller-owned values
before nested reads, matching existing hostile-input protections.

**Step 4: Run all Arch Design core tests**

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: all legacy scalar and new interface model tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesign*.test.ts
git commit -m "feat(schematic-core): model Arch Design interfaces"
```

### Task 5: Add Atomic Interface And Port Promotion Edits

**Files:**
- Modify: `packages/schematic-core/src/archDesign/edit.ts`
- Modify: `packages/schematic-core/test/archDesignEdit.test.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/test/schematicProtocol.test.ts`

**Step 1: Write failing reducer and untrusted-command tests**

Cover `setInterfaceOverride`, `clearInterfaceOverride`, `connectInterface`,
`removeInterfaceConnection`, `setInterfaceDefault`, `promotePort`,
`promoteInterface`, and `resyncInterfacePort`. Promotion must create the public
declaration plus connection in one edit. Verify Master promotion places the
top boundary in the connection's effective Slave endpoint and Slave promotion
does the inverse. Verify duplicate names and occupied members reject without a
partial result.

Also cover instance/interface/top-port rename and removal cascades through
overrides, connections, defaults, and `presentation.collapsedInterfaces`.

**Step 2: Run focused tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignEdit.test.js
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicProtocol.test.js
```

Expected: reducer union and protocol parser reject new commands.

**Step 3: Implement reducer operations and command normalization**

Make promotion payloads contain the already-resolved source pin/interface
snapshot so the reducer remains deterministic and catalog-independent. Always
reparse the finished design and preserve one native undo unit per logical edit.

**Step 4: Run focused and complete core tests**

```bash
npm test --workspace @veriflow/schematic-core
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicProtocol.test.js
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign/edit.ts \
  packages/schematic-core/test/archDesignEdit.test.ts \
  veriflow-vscode/src/schematic/protocol.ts \
  veriflow-vscode/src/test/schematicProtocol.test.ts
git commit -m "feat(schematic-core): edit Arch Design interfaces"
```

### Task 6: Resolve Interface Connections Once For All Consumers

**Files:**
- Create: `packages/schematic-core/src/archDesign/interfaces.ts`
- Modify: `packages/schematic-core/src/archDesign/definitions.ts`
- Modify: `packages/schematic-core/src/archDesign/resolution.ts`
- Modify: `packages/schematic-core/src/archDesign/validation.ts`
- Modify: `packages/schematic-core/src/archDesign/index.ts`
- Create: `packages/schematic-core/test/archDesignInterfaces.test.ts`
- Modify: `packages/schematic-core/test/archDesignValidation.test.ts`

**Step 1: Write failing semantic-expansion tests**

Pass an explicit protocol catalog into resolution. Cover inferred and
overridden roles, effective inversion of top-level boundary roles, one-to-one
connections, protocol mismatch, unknown role, member exclusivity against
scalar connections, paired members, sender-only open outputs, receiver-only
defaults, missing required defaults, connection-default precedence, and stale
promoted members. Width mismatches must be warnings, not validation errors.

Define one immutable expanded result containing resolved endpoints, member
bindings, open members, effective defaults with provenance, occupancy, errors,
and warnings. Validation, graphing, and export must accept this result rather
than repeat matching.

**Step 2: Run tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignInterfaces.test.js \
  packages/schematic-core/dist-test/test/archDesignValidation.test.js
```

Expected: current resolver emits `AD_INTERFACE_UNSUPPORTED`.

**Step 3: Implement snapshot-safe expansion and diagnostics**

Remove the blanket unsupported diagnostic. Preserve all invalid intermediate
designs for rendering, classify `AD_INTERFACE_WIDTH` as warning metadata, and
block export only for error diagnostics. Index endpoints and occupied scalar
ports to keep expansion linear in member count.

**Step 4: Run performance, hostile-input, and full core tests**

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: all tests pass and large multi-interface fixtures avoid peer-array
scans.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesign*.test.ts
git commit -m "feat(schematic-core): resolve Arch Design interfaces"
```

### Task 7: Project Collapsed And Expanded Interface Graphs

**Files:**
- Modify: `packages/schematic-core/src/model.ts`
- Modify: `packages/schematic-core/src/archDesign/graph.ts`
- Modify: `packages/schematic-core/src/archDesign/presentation.ts`
- Modify: `packages/schematic-core/src/layout.ts`
- Modify: `packages/schematic-core/src/nodeGeometry.ts`
- Modify: `packages/schematic-core/src/renderModel.ts`
- Modify: `packages/schematic-core/test/archDesignGraph.test.ts`
- Modify: `packages/schematic-core/test/archDesignPresentation.test.ts`
- Modify: `packages/schematic-core/test/layout.test.ts`

**Step 1: Write failing projection and layout tests**

Extend graph pins and networks with optional interface metadata instead of
inventing a separate renderer graph. Verify collapsed interfaces replace only
their unoccupied member pins with one aggregate pin, expanded members preserve
HDL declaration order, interface connections use one thicker semantic network,
and expanded views reveal real member networks/default constants. Verify
Slave-left/Master-right placement and colored top-level interface metadata.

**Step 2: Run focused tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignGraph.test.js \
  packages/schematic-core/dist-test/test/archDesignPresentation.test.js \
  packages/schematic-core/dist-test/test/layout.test.js
```

Expected: graph types and projection lack interface metadata.

**Step 3: Implement graph projection and reuse the router**

Use stable IDs such as `interface:instance:<instance>:<key>` and
`interface:port:<name>`. Feed aggregate interface networks through the same
orthogonal routing pipeline with a render-width hint; do not add automatic
geometry in X6. Keep collapsed state in presentation and semantic selection IDs
stable across expand/collapse.

**Step 4: Run all schematic-core layout tests**

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: scalar geometry guarantees and new interface projections pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src packages/schematic-core/test
git commit -m "feat(schematic-core): project interface schematics"
```

### Task 8: Export Expanded Interface RTL

**Files:**
- Modify: `packages/schematic-core/src/archDesign/rtl.ts`
- Modify: `packages/schematic-core/src/archDesign/fingerprint.ts`
- Modify: `packages/schematic-core/test/archDesignRtl.test.ts`

**Step 1: Write failing RTL tests**

Cover module-to-module AXI, internal Master/Slave promotion to same-role
top-level interfaces, deterministic public member names, original instance
port spelling, missing sender outputs, explicit defaults for missing receiver
inputs, default overrides, width-warning export, unsafe/missing default
blocking, collision-safe nets, Verilog and SystemVerilog, and fingerprints that
change when the effective protocol definition changes.

Compile representative generated Verilog with Icarus when available, keeping
the existing optional skip behavior.

**Step 2: Run RTL tests and verify RED**

```bash
npm run build --workspace @veriflow/schematic-core
npx tsc -p packages/schematic-core/tsconfig.test.json
node --test packages/schematic-core/dist-test/test/archDesignRtl.test.js
```

Expected: export remains blocked by unsupported interface diagnostics.

**Step 3: Generate RTL only from expanded bindings**

Expand promoted top ports from their persisted member snapshots. Use the
actual sender width for internal wires, emit named connections or explicit
constant expressions, omit sender-only members, and never generate a
SystemVerilog `interface` or hidden adapter module.

**Step 4: Run core tests**

```bash
npm test --workspace @veriflow/schematic-core
```

Expected: deterministic RTL and all scalar export tests pass.

**Step 5: Commit**

```bash
git add packages/schematic-core/src/archDesign packages/schematic-core/test/archDesignRtl.test.ts
git commit -m "feat(schematic-core): export interface connections"
```

### Task 9: Load Project Protocols In Flow Core And Node CLI

**Files:**
- Modify: `packages/flow-core/src/project.ts`
- Modify: `packages/flow-core/src/projectStore.ts`
- Modify: `packages/flow-core/test/projectStore.test.ts`
- Create: `packages/cli/src/runtime/interfaceProtocolLoader.ts`
- Modify: `packages/cli/src/commands/ad.ts`
- Modify: `packages/cli/test/adCommand.test.ts`

**Step 1: Write failing project and CLI tests**

Add `schematic.interface_protocols` fixtures and verify paths resolve relative
to the project file, round-trip without entering `extra`, and remain absent in
legacy projects. CLI tests cover standalone built-ins, project overrides,
missing/invalid protocol files, identical validate/export diagnostics, and an
override that changes explicit generated defaults.

**Step 2: Run focused tests and verify RED**

```bash
npm test --workspace @veriflow/flow-core
npm run build --workspace @veriflow/cli
npx tsc -p packages/cli/tsconfig.test.json
node --test packages/cli/dist-test/test/adCommand.test.js
```

Expected: project config drops the field and CLI always uses no protocol
catalog.

**Step 3: Implement host-only file loading**

Expose resolved protocol paths on `Project`. The CLI loader reads text, calls
the shared parser/catalog builder, and reports source-path diagnostics. Pass
the effective catalog into validation and export; do not add filesystem APIs to
schematic-core.

**Step 4: Run flow-core, CLI, and release tests**

```bash
npm test --workspace @veriflow/flow-core
npm test --workspace @veriflow/cli
node scripts/test-node-release.mjs
```

Expected: all tests pass from packed CLI artifacts as well as the workspace.

**Step 5: Commit**

```bash
git add packages/flow-core packages/cli
git commit -m "feat(cli): load project interface protocols"
```

### Task 10: Integrate Protocol Catalogs Into The VS Code Provider

**Files:**
- Create: `veriflow-vscode/src/archDesign/interfaceProtocolLoader.ts`
- Modify: `veriflow-vscode/src/archDesign/archDesignEditorProvider.ts`
- Modify: `veriflow-vscode/src/archDesign/archDesignExport.ts`
- Modify: `veriflow-vscode/src/archDesign/editorSupport.ts`
- Modify: `veriflow-vscode/src/schematic/protocol.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorProvider.test.ts`
- Modify: `veriflow-vscode/src/test/archDesignExport.test.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorSupport.test.ts`

**Step 1: Write failing provider tests**

Inject protocol loading through `ArchDesignEditorServices`. Cover built-ins,
workspace-project overrides, path diagnostics, file-change refresh, catalog
generation in revision tokens, stale command rejection, export using the same
catalog snapshot, and selection/layout preservation when a protocol refresh
does not alter the resolved graph.

**Step 2: Run focused tests and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/archDesignEditorSupport.test.js
node veriflow-vscode/out/test/archDesignExport.test.js
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
```

Expected: service/provider snapshots have no protocol catalog.

**Step 3: Implement URI-aware loading and snapshot plumbing**

Watch project protocol URIs for create/change/delete, parse through the shared
core, merge protocol diagnostics with Arch Design diagnostics, and pass one
catalog snapshot to projection and export. Keep presentation acknowledgements
lightweight and do not regress the interaction-refresh fix.

**Step 4: Run the VS Code test suite**

```bash
xvfb-run -a npm test --prefix veriflow-vscode
```

Expected: all extension tests and VSIX prepublish checks pass.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/archDesign veriflow-vscode/src/schematic/protocol.ts \
  veriflow-vscode/src/test
git commit -m "feat(vscode): resolve Arch Design interfaces"
```

### Task 11: Add Interface Inspector Models And Promotion Commands

**Files:**
- Modify: `veriflow-vscode/src/schematic/webviewSupport.ts`
- Modify: `veriflow-vscode/src/archDesign/editorSupport.ts`
- Modify: `veriflow-vscode/src/test/schematicWebviewSupport.test.ts`
- Modify: `veriflow-vscode/src/test/archDesignEditorSupport.test.ts`

**Step 1: Write failing projection tests**

Verify selecting an ordinary module pin exposes instance, port, direction,
actual width, interface membership, occupancy, and one `Expose as top-level
port` action. Selecting a collapsed interface exposes protocol, role/source,
members, missing members, peer, defaults/provenance, warnings, collapse state,
overrides, and `Expose as top-level interface`. Top-level interface selection
adds `Resynchronize from current connection`.

**Step 2: Run focused tests and verify RED**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/archDesignEditorSupport.test.js
```

Expected: current Inspector recognizes nodes and scalar networks only.

**Step 3: Implement host-projected form/action models**

Keep webview fields generic. Project exact typed reducer payloads for role and
protocol overrides, defaults, scalar/interface promotion, collapse state, and
resynchronization. Keep the Add Port model scalar-only.

**Step 4: Run support and provider tests**

```bash
npm run compile:ts --prefix veriflow-vscode
node veriflow-vscode/out/test/schematicWebviewSupport.test.js
node veriflow-vscode/out/test/archDesignEditorProvider.test.js
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add veriflow-vscode/src/schematic/webviewSupport.ts \
  veriflow-vscode/src/archDesign/editorSupport.ts veriflow-vscode/src/test
git commit -m "feat(vscode): expose interface authoring models"
```

### Task 12: Render And Edit Interfaces In The Shared Webview

**Files:**
- Modify: `packages/schematic-webview/src/index.ts`
- Modify: `packages/schematic-webview/src/index.css`
- Modify: `packages/schematic-webview/src/index.html`
- Modify: `packages/waveform-desktop/test/schematicWebview.test.ts`
- Modify: `web-dist/schematic/index.js`
- Modify: `web-dist/schematic/index.css`
- Modify: `web-dist/schematic/index.html`

**Step 1: Write failing Electron tests**

Cover pin-level selection and Inspector details, scalar promotion, collapsed
interface labels and thicker routes, Master-to-Slave drag, unknown-role disabled
connection, expand/collapse continuity, member promotion after expansion,
colored top-level interface tags, default override forms, and explicit
resynchronization. Verify selection and viewport survive local collapse,
promotion acknowledgement, and protocol graph refresh whenever IDs survive.

Include desktop and narrow viewport screenshots plus overlap and canvas-pixel
checks for the new labels and routes.

**Step 2: Run Electron tests and verify RED**

```bash
npm run build:web
xvfb-run -a npm test --workspace @veriflow/waveform-desktop
```

Expected: interface cells/actions are absent.

**Step 3: Implement rendering and interactions**

Use X6 cells only to render core geometry. Add semantic hit targets for pins
and aggregate interfaces, Lucide icons and tooltips for unfamiliar actions,
one restrained interface-label palette distinct from scalar ports, and no
nested cards. Maintain stable control dimensions and Inspector overflow at
narrow widths.

**Step 4: Rebuild generated assets twice and verify determinism**

```bash
npm run build:web
sha256sum web-dist/schematic/index.{js,css,html}
npm run build:web
sha256sum web-dist/schematic/index.{js,css,html}
xvfb-run -a npm test --workspace @veriflow/waveform-desktop
```

Expected: hashes are identical and every Electron test passes without blank or
overlapping canvas content.

**Step 5: Commit**

```bash
git add packages/schematic-webview packages/waveform-desktop/test/schematicWebview.test.ts \
  web-dist/schematic
git commit -m "feat(webview): edit collapsed interfaces"
```

### Task 13: Package, Document, And Verify The Complete Workflow

**Files:**
- Modify: `README.md`
- Modify: `veriflow-vscode/README.md`
- Modify: `veriflow-vscode/src/test/schematicAssets.test.ts`
- Modify: `veriflow-vscode/src/test/vsixPackaging.test.ts`
- Modify: `packages/flow-core/test/boundaries.test.ts`
- Modify: `scripts/test-node-release.mjs`

**Step 1: Write failing packaging assertions**

Require the four built-in JSON protocol assets and interface runtime markers in
the schematic-core tarball, packed Node CLI, extension bundle, and VSIX. Assert
that source/test directories and Python artifacts remain absent.

**Step 2: Run packaging checks and verify RED**

```bash
npm pack --dry-run --workspace @veriflow/schematic-core --json
node scripts/test-node-release.mjs
npm run vscode:prepublish --prefix veriflow-vscode
node veriflow-vscode/out/test/vsixPackaging.test.js
```

Expected: new interface asset/marker assertions fail until packaging is wired.

**Step 3: Finish packaging and concise documentation**

Document project protocol references, built-in protocols, interface promotion,
expand/collapse, one-to-one connections, defaults, warnings, and RTL export.
Keep the root README concise and Chinese. State that protocols do not define
widths and that width mismatches warn rather than block export.

**Step 4: Run the complete verification matrix**

```bash
npm run verify:generated
xvfb-run -a npm test
npm run test:release
npm pack --dry-run --workspace @veriflow/schematic-core
npm pack --dry-run --workspace @veriflow/cli
git diff --check
git status --short --branch
```

Expected: all commands exit 0. The only permitted skip is optional generated
RTL compilation when `iverilog` is unavailable. No tarball, VSIX, temporary
protocol, or generated output remains untracked.

**Step 5: Request review and address findings**

Use `@superpowers:requesting-code-review`, add regression tests for every valid
finding, then repeat the affected focused suite and the full matrix.

**Step 6: Commit**

```bash
git add README.md veriflow-vscode packages/flow-core/test/boundaries.test.ts \
  scripts/test-node-release.mjs
git commit -m "docs: document interface authoring"
```

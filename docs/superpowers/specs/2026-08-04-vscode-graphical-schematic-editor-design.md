# VS Code Graphical Schematic Editor Design

## Summary

Add an optional graphical editor for Verilog and SystemVerilog source files in the VeriFlow VS Code extension. The editor presents one module at a time as a left-to-right structural schematic containing top-level ports, module instances, named networks, constants, expressions, and opaque external logic.

Users can add and remove ports and instances, edit parameters, connect pins, rename networks, and preview the exact Verilog changes before applying them. Graph edits remain staged outside the text document until the user approves a native VS Code diff. Applying the result is one atomic `WorkspaceEdit` and is reversible with one VS Code undo.

All Verilog/SystemVerilog source parsing in the extension will move behind one TypeScript-owned syntax and semantic layer backed by the MIT-licensed `tree-sitter-systemverilog` WASM parser. Existing module scanning, dependency analysis, module instantiation, and Testbench generation will use the same indexed model as the schematic editor.

## Goals

- Keep the normal text editor as the default editor for `.v` and `.sv` files.
- Offer a graphical schematic editor through Open With, Explorer context menus, the Command Palette, and the editor title bar.
- Display one selected module per canvas when a source file contains multiple modules.
- Render top-level ports, module instances, named networks, constants, simple selects, expressions, and opaque external logic.
- Place inputs on the left, outputs on the right, and module data flow from left to right.
- Add modules from a path-qualified workspace module library.
- Add `input` and `output` ports from the canvas; do not add new `inout` ports.
- Connect pins by dragging and support fan-out by attaching pins to existing networks.
- Edit instance names, parameter overrides, network names, and top-level port properties.
- Generate missing `wire` declarations and boundary `assign` statements.
- Apply confirmed zero-extension and truncation rules for known width mismatches.
- Preserve unrelated and unsupported source text byte-for-byte.
- Preview all source changes in the native VS Code Diff Editor before applying them.
- Persist layouts and uncommitted graph drafts outside the project directory.
- Make every HDL consumer depend on one parser facade and normalized TypeScript model.
- Keep parsing off the extension host event loop and cache a lightweight workspace index.

## Non-Goals

- Do not replace the default text editor for Verilog or SystemVerilog files.
- Do not implement a full SystemVerilog elaborator or simulator.
- Do not rewrite `tree-sitter-systemverilog` in TypeScript.
- Do not edit the interior of procedural blocks, functions, tasks, macros, or arbitrary expressions graphically.
- Do not add new `inout` ports from the schematic editor.
- Do not automatically perform sign extension.
- Do not silently resolve multiple drivers or ambiguous module definitions.
- Do not individually edit an elaborated element of a generate loop or instance array when the source contains one shared template.
- Do not store graph positions in Verilog comments or project sidecar files.
- Do not replace the VCD parser, simulation log parser, or other non-HDL parsers with the SystemVerilog parser.
- Do not package the complete `tree-sitter-systemverilog` npm module, generated C source, CLI, or all native prebuilds in the VSIX.

## Confirmed Technology Decisions

- Parser grammar: `gmlarumbe/tree-sitter-systemverilog` pinned to `v0.4.0` and ABI 15.
- Parser runtime: `web-tree-sitter` with the released SystemVerilog language WASM.
- Parser execution: one lazy Node worker shared by all HDL consumers.
- Extension language: TypeScript with VeriFlow-owned parser interfaces, semantic models, and edit planning.
- Graph canvas: AntV X6 with orthogonal routing and a separate left-to-right layout pass.
- Custom editor type: `CustomTextEditorProvider` so text and graphical editors share the VS Code document.
- Source preview: native VS Code Diff Editor backed by a virtual proposed document.
- Source application: one atomic `WorkspaceEdit` after a second version check.
- Layout persistence: VS Code `workspaceState`, keyed by file URI and module identity.
- Draft persistence: extension workspace storage, not the source tree.

## High-Level Architecture

```text
.v/.sv TextDocument
        |
        v
SystemVerilogParser facade
        |
        v
TreeSitterSystemVerilogBackend -- owns CST-specific knowledge
        |
        v
HdlDocument / ModuleModel / expression and source-span models
        |                              |
        v                              v
WorkspaceHdlIndex              SchematicModelBuilder
        |                              |
        |                              v
        |                       SchematicSession
        |                              |
        |                              v
        |                         X6 Webview
        |                              |
        |                              v
        |                       SourcePatchPlanner
        |                              |
        |                              v
        |                       Native Diff Preview
        |                              |
        +------------------------------v
                                WorkspaceEdit
```

Only `TreeSitterSystemVerilogBackend` may depend on raw CST node names. All downstream code consumes VeriFlow models. This isolates upstream grammar changes and permits a future parser replacement without changing module scanning, dependency analysis, Testbench generation, or the schematic editor.

## Parser Packaging And Loading

The VSIX will ship only these parser assets:

- `tree-sitter-systemverilog.wasm`;
- the production `web-tree-sitter` runtime WASM;
- bundled runtime JavaScript;
- required MIT license and third-party notices.

The extension must not publish `src/parser.c`, grammar JSON, the Tree-sitter CLI, native `.node` files, or unused platform prebuilds. The language WASM and runtime are copied as explicit build assets and verified by a pinned checksum.

The parser loads on the first HDL parsing request, which may come from the module view, dependency analysis, module instantiation, Testbench generation, or the schematic editor. Merely activating the extension must not load the WASM.

## Parser Worker

A single Node worker owns the Tree-sitter runtime, language object, active syntax trees, and parse queue.

- Interactive document parses have priority over workspace indexing.
- Background scans are cancellable and yield between files.
- Open documents use `TextDocument.getText()`, including unsaved changes.
- Closed files use their on-disk contents.
- Active document trees remain in the worker for incremental parsing.
- Lightweight summaries are posted back to the extension host; raw Tree-sitter objects never cross the worker boundary.
- The extension host and Webview never load a second copy of the language WASM.

## Normalized HDL Models

### HdlDocument

`HdlDocument` contains:

- URI and language mode;
- document version or disk fingerprint;
- source text identity and line-ending style;
- modules, interfaces, packages, directives, and includes;
- parse diagnostics;
- preprocessing configuration fingerprint;
- byte-to-UTF-16 position mapping.

Tree-sitter reports UTF-8 byte offsets while VS Code edits use UTF-16 positions. All CST ranges must be converted through a document-owned mapping service before producing a `vscode.Range`.

### ModuleModel

`ModuleModel` contains:

- stable session identity and source identity;
- module name and optional end label;
- ANSI or non-ANSI declaration style;
- header, body, declaration-region, and `endmodule` source spans;
- parameters and local parameters;
- top-level ports;
- module-scope nets and variables;
- continuous assignments;
- explicit instances and instance arrays;
- generate structures;
- opaque structural or procedural regions;
- module-level symbol and reference tables.

### Structural Elements

- `ParameterModel`: name, declared type, default expression, resolved value, and source spans.
- `PortModel`: name, direction, type text, packed range, known/symbolic/unknown width, declaration style, and source spans.
- `InstanceModel`: selected definition URI, module name, instance name, parameter connections, port connections, syntax form, and complete source span.
- `NetModel`: declaration, name, range, resolved width, unique driver, loads, references, and creation origin.
- `ExpressionModel`: normalized kind, raw text, source span, and inferred width.
- `OpaqueLogicModel`: raw source range, boundary signals, and a reason that the interior is not graphically editable.

Each editable model retains normalized values, original text, and precise source spans. Session IDs are independent of byte offsets. Reparsing rematches elements through file identity, module identity, semantic names, and source anchors.

## Preprocessing

The schematic displays only the active preprocessing branch.

- Add a `veriflow.defines` setting for active macro names and optional values.
- Reuse configured include and library directories for include resolution.
- Preserve inactive `` `ifdef`` branches exactly but exclude them from the active schematic model.
- Include and define configuration changes invalidate affected index entries.
- Macro constructs that cannot be safely expanded become opaque macro or external-logic nodes.
- Guessing compile defines from arbitrary custom simulator command strings is not required.

Preprocessing must retain a source map back to the original document. No source edit may target only transformed or expanded text without an unambiguous original span.

## Workspace HDL Index

`WorkspaceHdlIndex` becomes the only workspace module and dependency index. It stores lightweight summaries in extension workspace storage:

- file URI, modification time, size, and content hash;
- module, interface, and package declarations;
- parameter and port summaries;
- include relations and module-instance dependencies;
- duplicate definitions with all source paths;
- parse diagnostics and preprocessing fingerprints.

Full CSTs are not persisted. Startup loads valid summaries and reparses only changed files. File watchers incrementally update `.v`, `.sv`, `.vh`, and `.svh` entries. Include changes invalidate dependent source files.

Duplicate module names are a scan concern:

- list every definition by source path;
- write one consolidated warning to the VeriFlow Output Channel;
- show a status-bar warning summary;
- do not show modal or transient warning popups;
- allow module pickers to choose an exact definition file.

## Existing Feature Migration

All HDL source consumers migrate to the normalized model:

- workspace module scanning;
- top-module selection;
- dependency analysis and compile ordering;
- module instantiation selection and port/parameter extraction;
- VS Code Testbench generation;
- graphical schematic construction;
- future HDL features.

The existing aligned `moduleInstantiationFormatter` remains the only code that renders named module instances. The Testbench generator and schematic source planner both use it. Existing formatting and output tests must remain unchanged unless a separately approved behavior change is required.

The current VCD, waveform-index, and simulator-log parsers remain independent because they do not parse Verilog/SystemVerilog source structure.

## Custom Editor Entry Points

Register the schematic editor with optional priority for `.v` and `.sv` selectors. Text editing remains the default.

Entry points:

- `Open With... -> VeriFlow Schematic Editor`;
- Explorer context command `Open in VeriFlow Schematic`;
- Command Palette command `VeriFlow: Open Schematic Editor`;
- editor-title schematic icon for active Verilog/SystemVerilog documents.

When a file contains multiple modules, opening the editor presents a module choice. The Webview header retains a module selector. One canvas displays one module, but a file session may hold pending edits for several modules.

Generating Verilog produces one candidate document containing every pending module change in that file. A blocking error in any modified module blocks the file-level generation and provides a command to navigate to the affected module.

## Schematic Session

A `SchematicSession` is keyed by document URI and shared by all graphical panels for the file. It contains:

- the base document version and content hash;
- normalized module models;
- one command journal per module;
- graph undo and redo stacks;
- selected definition bindings for ambiguous instances;
- draft identity and validation state;
- subscriptions for every open Webview panel.

Panels may display different modules but receive the same file-session updates. A text-side source change moves every panel into conflict state and disables generation until the session is reloaded or discarded.

Graph commands do not modify the text document. After a successful source application, the session reparses the document, rematches elements, clears applied command journals, and broadcasts the refreshed model.

## Draft Persistence

Pending graph commands are automatically persisted under the extension workspace storage URI. Drafts never create files in the user's project.

A draft stores:

- file URI and module identities;
- base source hash;
- graph commands and generated object identities;
- ambiguous module-definition bindings;
- enough metadata to summarize pending changes.

Closing or restarting VS Code must not lose a draft. If the source hash still matches, reopening restores it automatically. If the source changed, the draft enters conflict state and is not replayed automatically. The user may inspect its summary and discard it or reproduce the edits manually. Applying or explicitly discarding a draft deletes it.

## Layout Persistence

Node coordinates, fixed-node state, viewport, and optional minimap state are stored in `workspaceState`, keyed by file URI and module identity. Layout state is separate from graph edits and never marks the source as pending generation.

After reparsing, positions are retained for rematched elements. New nodes receive automatic placement. Manual node positions remain fixed during partial auto-layout. `Relayout All` explicitly clears fixed state and recalculates the entire graph.

## Canvas Composition

- Top-level inputs appear on the left with one-way arrows.
- Top-level outputs appear on the right with one-way arrows.
- Existing top-level `inout` ports appear after inputs with bidirectional arrows.
- New `inout` ports are not offered.
- Instance nodes are rectangles with the instance name in the header and module name in the footer.
- Instance inputs appear on the left, outputs on the right, and `inout` pins on the bottom edge.
- Constant and expression nodes display their literal or raw expression text.
- Opaque logic is a visually distinct read-only block labeled by boundary signal or construct.
- Networks use orthogonal paths with a shared trunk for fan-out.
- Selected networks expose their name, width, driver, loads, and inserted width adapters.

Left-side tools provide:

- add Input Port;
- add Output Port;
- add Constant;
- search and add workspace modules, with path-qualified duplicate definitions.

The right-side inspector edits the current instance, port, network, constant, or expression properties. The toolbar contains fit, 100% zoom, auto-layout, undo, redo, search, validation counts, and Generate Verilog.

## Canvas Interaction

- Drag a module from the library or select it and place it on the canvas.
- Drag from one pin to a compatible pin to create a network.
- Drop a pin on an existing network to create a branch.
- Reject or mark invalid connections according to direction and driver rules.
- Select a network to rename it and inspect all endpoints.
- Select an instance to rename it or edit parameter overrides.
- Select a top-level port to rename it, edit width, or switch between input and output.
- Existing `inout` may remain bidirectional or change to input/output; other ports cannot change to `inout`.
- Delete instances, ports, constants, and connections with Delete or a context command.
- Deleting an existing top-level port is allowed; known references become warnings and are shown in the diff.
- Graph undo and redo operate on the staged command journal. After source application, VS Code document undo handles the atomic source change.

New networks use the unique driver's pin or top-level port name. Name conflicts add `_1`, `_2`, and so on. The inspector can rename the network later.

## Navigation And Large Graphs

- Double-click an instance to open its bound module in a schematic editor.
- If the target module is in the same file, switch the current module selector.
- Instance context commands open the module schematic, go to the module definition, or reveal the instance source.
- Port, network, expression, and opaque-node context commands reveal source where possible.
- VS Code navigation history handles cross-file forward and back navigation.
- Returning to a schematic restores selection and viewport.
- Support wheel zoom, background pan, box selection, and multi-node movement.
- Search by instance name, module name, port name, or network name and step through results.
- Route feedback edges above or below the main flow instead of reversing their meaning.
- Show an optional minimap only when content substantially exceeds the viewport.

## Instance Creation And Definition Binding

New instances use `u_<module_name>` and add numeric suffixes on conflict. They retain the exact selected definition URI in session and workspace metadata. Verilog output still contains only the module name.

If duplicate definitions prevent a unique binding after reopening, mark the instance definition as ambiguous and let the user choose a path in the inspector. Do not show a popup. The broader duplicate-module warning remains in the Output Channel and status bar.

The parameter inspector shows parameter names, defaults, explicit overrides, and resolved values. Restoring a default removes a new override. Existing explicitly written overrides remain explicit even when equal to the current default.

New instances emit only parameters explicitly overridden by the user. They emit every named port in definition order, using `.port_name()` for unconnected ports. Both groups use the shared aligned instantiation formatter.

## Existing Instance Syntax

- Named `.port(expression)` connections are editable by replacing only the expression span when possible.
- Implicit `.port` connections are normalized in the graph and expand to `.port(new_expression)` when edited.
- Empty `.port()` connections remain visible as unconnected pins.
- Positional connections map through the selected definition's port order.
- The first edit to a positional instance rewrites the complete instance into the shared named format.
- The first edit to a `.*` instance resolves same-name connections and rewrites the complete instance into explicit named connections.
- Positional parameter overrides similarly convert to named overrides on first edit.
- If a definition or order cannot be determined, the instance remains visible but read-only.
- Multiple instances in one declaration are modeled individually, but an edit planner may rewrite the complete declaration when punctuation or shared syntax makes a smaller patch unsafe.

## Generate And Instance Arrays

- Ordinary module-scope instances are fully editable.
- A known active `if generate` branch is displayed, and uniquely mapped source instances may be edited.
- Unknown `if/case generate` conditions become read-only generate blocks with condition labels and boundary networks.
- Known `for generate` bounds produce a collapsible `GenerateArray` node such as `u_stage[0..7]`.
- Expanded generate elements are inspectable but cannot be edited independently from the source template.
- Shared template parameters or connection expressions may be edited once for every elaborated element.
- Unknown loop bounds remain collapsed and show template structure and boundary connections.
- Explicit instance arrays follow the same rule: shared syntax may be edited; an individual array element may not.
- Macro-generated instances, UDPs, gate primitives, interfaces, and modports are rendered as read-only external structural nodes until separately designed editing support exists.

## Network Direction Rules

Each named network permits one unambiguous driver and any number of loads.

Drivers:

- top-level input;
- instance output;
- constant;
- recognized external-logic output.

Loads:

- top-level output;
- instance input.

`inout` is bidirectional and is excluded from automatic extension and truncation. Known `inout` width mismatch is blocking. Multiple drivers are blocking. Illegal direction connections are rejected or remain visibly invalid until corrected.

## Width Model And Adaptation

Widths have three states:

- `Known(n)`: a concrete positive bit count;
- `Symbolic(expression)`: a valid but unresolved parameter expression;
- `Unknown`: no reliable expression is available.

Named network width follows its unique source. Every load adapts independently.

For known widths:

- narrow source to wide load uses zero extension;
- wide source to narrow load selects the least-significant load-width bits;
- no sign extension is automatic.

Examples:

```systemverilog
{4'd0, src_wire_name}
{{(DST_WIDTH-SRC_WIDTH){1'b0}}, src_wire_name}
src_wire_name[7:0]
```

Selection must respect a source's actual declared range. A non-zero-based range such as `[15:8]` selects the correct least-significant indices, for example `[11:8]`, instead of generating invalid `[3:0]`. Generated networks use normalized `[N-1:0]` ranges.

The TypeScript constant-expression evaluator is AST based and never uses JavaScript `eval`. It supports parameter references, common arithmetic and bitwise operators, conditional expressions, and `$clog2`. Parameter changes trigger width recomputation for the instance and adjacent networks.

Symbolic or unknown widths may be connected and generated without automatic adapters. They produce warnings in the canvas and diff. Users may resolve them by setting parameters or explicit port widths.

Every automatic extension or truncation is visible on the connection and in the source preview.

## Constants And Inline Expressions

Constants and read-only expressions are inline sources when they have one load:

- a constant may be written directly in an instance connection;
- a constant driving a top-level output becomes a direct boundary `assign`;
- a simple read-only expression remains directly in its original or new load connection.

An inline source materializes into a named network when:

- it has multiple loads;
- the user assigns a network name;
- width adaptation requires a shared source-width boundary; or
- the original source already uses a named net.

Materialization creates a `wire` and one `assign` from the expression to the wire. A generated materialized net can be renamed and branched like any other network.

Disconnecting the final load may remove a declaration and assignment only when both were created by the current graph edit and are no longer referenced. Existing source objects are never automatically deleted as cleanup.

## Source Patch Planning

All staged commands convert into one `SourcePatchPlan`. Each edit includes:

- original source span;
- exact expected old text;
- replacement text;
- owning module and semantic operation;
- source model version.

Edits are validated for overlap and applied from the end of the document toward the beginning. A failed precondition aborts the complete plan; partial application is forbidden.

### Existing Source Edits

- Named instance connection changes replace only the expression span.
- Parameter changes replace only the parameter-value span.
- Instance renames replace only the instance identifier.
- A safely identifiable existing instance deletion removes its full span and associated empty line.
- Network renames update the declaration and references resolved to the same module-level symbol.
- Comments, strings, structure members, local variables, and symbols in other scopes are not renamed.
- Possible macro references are warned about but not guessed.

### New Source

- New instances use the shared aligned formatter and insert immediately before the selected module's `endmodule`.
- New nets use `wire` and insert after parameters, ports, and existing net declarations but before the first process or instance.
- New continuous assignments insert after declarations and the existing continuous-assignment region.
- New source follows the file's line endings, indentation, and final-newline convention.

### Added And Removed Ports

- Preserve ANSI or non-ANSI style.
- Add a new input after the last existing input.
- Add a new output after the last existing output.
- Do not reorder existing ports.
- For non-ANSI modules, update both the header name list and body declaration.
- Deleting a port removes its header item and applicable body declaration item.
- Removing one name from a grouped declaration preserves the remaining declaration and punctuation.
- Known surviving references after deletion are warnings and do not block application.

### Boundary Assignments

For a newly added boundary port attached to an existing differently named network:

```systemverilog
assign signal_name = input_port_name;
assign output_port_name = signal_name;
```

When a new network can use the boundary port name directly, no extra assignment is generated.

## Source Preservation And Safety

Unrelated and unsupported source must remain byte-identical. The planner must prefer narrow edits over full-module formatting. Full instance rewriting is limited to confirmed conversion cases such as positional, implicit, or wildcard syntax where narrow patching cannot express the change.

Before presenting a diff:

1. verify the current document version and base hash;
2. reparse the current source;
3. revalidate every old-text precondition and span;
4. construct the candidate source in memory;
5. parse the candidate source;
6. reject any new syntax errors in the edited module;
7. compute diagnostics and the diff virtual document.

The original source may already contain parse errors. The candidate must not add errors or worsen an existing edited-region error baseline.

## Native Diff And Application

Generate Verilog opens the native VS Code Diff Editor:

- left: current source document;
- right: read-only virtual candidate document;
- normal VS Code syntax highlighting, unchanged-region folding, and change navigation;
- Apply Changes and Discard Preview remain available from the schematic toolbar or command flow.

The preview is tied to one document version and candidate identity. Any source change invalidates it. Apply performs a second version and old-text check, then submits one `WorkspaceEdit`. One VS Code undo reverts the result.

After application, all schematic panels reparse and refresh. The applied draft and graph undo stack are cleared.

## External Source Changes

If the text editor, a formatter, source-control operation, or external program changes the file after the graph session baseline:

- mark every graphical panel as conflicted;
- disable generation and application;
- invalidate an open candidate diff;
- offer Reload From Source or Discard Graph Draft;
- never automatically overwrite or replay onto the changed source.

## Diagnostics

### Blocking Errors

- source version or expected-text mismatch;
- invalid or overlapping source edits;
- illegal or duplicate identifiers in the same scope;
- multiple network drivers;
- illegal connection direction;
- missing or unparseable definition for a new instance;
- new syntax errors in candidate source;
- known `inout` width mismatch;
- attempted edits to an unmappable positional, wildcard, generate, or array construct.

Blocking errors disable Generate Verilog.

### Non-Blocking Warnings

- symbolic or unknown width;
- automatic zero extension or truncation;
- known references after deleting a top-level port;
- possible macro or opaque-logic references during rename;
- unconnected instance inputs or undriven top-level outputs;
- unused existing wires after deletion;
- read-only expressions or external structures;
- duplicate workspace module definitions.

Warnings permit diff preview and application.

### Presentation

- node, pin, and edge markers on the canvas;
- details in the selected object's inspector;
- toolbar error and warning counts;
- `DiagnosticCollection` entries for source-mappable issues;
- Output Channel and status-bar summaries for duplicate workspace modules;
- no duplicate-module popup warnings.

## Webview Security And Messaging

- Use a strict Content Security Policy and nonce-based scripts.
- Load only extension-local bundled resources.
- Validate every Webview message against a discriminated command schema.
- Treat labels, source expressions, paths, and diagnostics as text, never trusted HTML.
- Keep file-system access and source application in the extension host.
- Do not evaluate HDL expressions as JavaScript.
- Return structured validation errors instead of accepting malformed graph commands.

## Delivery Phases

1. Parser foundation: WASM worker, parser facade, normalized models, preprocessing configuration, and cache.
2. Existing feature migration: module scan, dependency analysis, instantiation, and Testbench parsing.
3. Read-only schematic: custom editor, module selection, graph construction, layout, navigation, and source reveal.
4. Graph editing session: add/delete, connect, rename, parameters, local undo, layout, and draft persistence.
5. Source round trip: patch planning, shared formatting, native diff, conflict checks, and atomic application.
6. Semantic completion: width evaluator, adapters, positional/wildcard conversion, generate and array presentation, and full diagnostics.
7. Stabilization: large-workspace performance, recovery, malformed source, packaging, and cross-platform tests.

Editing remains experimental until source patching and diff application satisfy the acceptance criteria. Each phase may merge independently, but incomplete editing must not be exposed as a source-modifying production workflow.

## Testing

### Parser And Model Tests

- Pin the grammar version and verify required node types and fields.
- Golden tests for ANSI and non-ANSI modules, parameters, ports, nets, assignments, expressions, instances, macros, and generate constructs.
- Tests for UTF-8 byte to UTF-16 position conversion.
- Active preprocessing branch and include dependency tests.
- Incremental document parse and persistent-index invalidation tests.
- Duplicate module path and output-warning tests.

### Existing Feature Regression

- Preserve all current module scan and dependency tests.
- Preserve exact aligned instantiation formatting.
- Preserve exact VS Code Testbench output unless a separately approved change exists.
- Assert that structural HDL parsing no longer uses the legacy regex parser after migration.

### Graph And Semantic Tests

- Endpoint direction, driver/load classification, fan-out, and multiple-driver detection.
- Known, symbolic, and unknown width propagation.
- Parameter override recomputation.
- Zero extension, parameterized extension, and range-aware truncation.
- Constants, expression materialization, and generated-name collision handling.
- Generate and instance-array shared-template restrictions.

### Patch Tests

- Add, remove, rename, and reconnect every supported object type.
- Convert positional, implicit, and wildcard instances to named syntax.
- Insert into ANSI and non-ANSI module headers.
- Preserve CRLF/LF, comments, whitespace, UTF-8 text, escaped identifiers, and final-newline state.
- Parse candidate source and assert no new errors.
- Assert every untouched source slice is byte-identical.
- Assert patch precondition failure applies nothing.
- Assert application is one reversible workspace edit.

### Session And VS Code Integration Tests

- Custom editor entry points and multi-module selection.
- Shared sessions across multiple panels.
- layout persistence independent of graph drafts;
- graph draft close, restart, restore, conflict, apply, and discard;
- source version conflict and diff invalidation;
- native diff virtual document lifecycle;
- Problems, Output Channel, and status-bar diagnostic presentation.

### Webview Tests

- module search and path-qualified duplicate entries;
- add, drag, connect, branch, disconnect, and delete interactions;
- selection and inspector updates;
- parameter changes and width refresh;
- zoom, pan, box selection, search, minimap, and auto-layout;
- source-navigation message handling;
- large graph rendering without overlapping labels or incoherent connections.

### Performance And Packaging

- benchmark initial indexing, one-file reparse, and incremental edits;
- record worker memory after WASM load and after large parses;
- benchmark representative large node and edge counts;
- verify the extension host stays responsive during indexing;
- verify the VSIX includes only the required parser assets;
- run packaging and integration checks for Windows, Linux, and macOS;
- optionally run upstream parser corpora in CI without publishing third-party fixtures in the VSIX.

## Acceptance Criteria

- `.v` and `.sv` still open as text by default and can be opened explicitly in the schematic editor.
- A multi-module file can switch among independent module canvases.
- Inputs, outputs, existing `inout`, instances, nets, constants, expressions, and opaque logic follow the confirmed visual rules.
- Module and port creation, deletion, connection, parameter editing, and network rename work through a staged graph session.
- New instances use the shared aligned formatter immediately before the selected module's `endmodule`.
- New ports preserve module declaration style and generate the confirmed boundary assignments.
- New source-width networks create correct `wire` declarations.
- Known width mismatches generate the confirmed zero extension or range-aware truncation.
- Symbolic and unknown widths warn but do not receive guessed adapters.
- Positional and wildcard instances convert to explicit named syntax on first supported edit.
- Generate and instance-array elements obey shared-template editing restrictions.
- Unsupported logic remains visible at its boundary and unchanged in source.
- The native diff shows every candidate source change before application.
- Source changes during a graph session or preview cannot be overwritten silently.
- A failed edit precondition cannot produce a partial source update.
- Applying changes is one VS Code undo step.
- Layout and uncommitted draft state survive the confirmed lifecycle without project sidecar files.
- Duplicate modules warn only through Output Channel and status bar and remain path-qualified in pickers.
- Every HDL source consumer uses the unified parser facade and normalized model.
- Existing instantiation and Testbench behavior remains covered by regression tests.
- Candidate source adds no syntax errors and untouched source remains byte-identical.

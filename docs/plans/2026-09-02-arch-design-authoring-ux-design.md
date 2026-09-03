# Arch Design Authoring UX Improvements

## Summary

This change removes several avoidable steps and false errors from Arch Design
authoring. Unconnected instance inputs receive an implicit constant zero in
validation, the Inspector, and RTL export without adding a canvas node;
instance names are generated automatically, duplicate HDL module names remain
selectable by source definition, and every primary toolbar action receives a
keyboard shortcut. The same delivery also refreshes the npm lockfile to remove
the seven reported development-dependency vulnerabilities.

The HDL parser is not replaced or supplemented. Investigation confirmed that
the shared Tree-sitter frontend already parses non-ANSI Verilog ports such as
`module legacy(clk); input clk; endmodule`. The observed empty-port node occurs
after parsing: Arch Design discards source identity, sees multiple definitions
with the same name, refuses to bind any definition, and consequently has no
ports to render.

## Goals

- Treat every undriven instance input as an effective zero in validation, the
  Inspector, and generated RTL, without projecting a constant box.
- Let an author select an input pin and override its default constant.
- Generate instance names in the form `u_<module_name>_<number>`, starting at
  zero and counting independently for each module name.
- Distinguish duplicate module definitions by source file and retain the exact
  selected definition in the Arch Design model.
- Add keyboard access for every primary Arch Design toolbar operation.
- Remove all seven current npm audit findings without forced or major direct
  dependency upgrades.

## Non-Goals

- Developing or exposing the TypeScript simulator backend.
- Adding another HDL parser or a special non-ANSI port parser for Arch Design.
- Changing the behavior of undriven top-level outputs.
- Adding user-customizable VS Code keybindings in this iteration.
- Adding a visible shortcut reference panel or shortcut text to the UI.
- Changing instance numbering based on source file. Duplicate definitions with
  the same module name share the same instance-name sequence.

## Architecture

The shared HDL data path remains:

```text
Tree-sitter HDL frontend
  -> ModuleModel
  -> WorkspaceHdlIndex / HdlDefinitionSummary
  -> ArchDesignModuleDefinition projection
  -> Arch Design resolver, graph, inspector, and RTL export
```

Arch Design keeps its domain projection because the core package must remain
independent of VS Code and workspace services. The projection is not allowed to
reinterpret HDL syntax. It carries the definition identity, parameters, ports,
directions, and widths already produced by the shared frontend.

`ArchDesignInstance` gains an optional definition reference alongside the
module name. New instances store both. Resolution first matches the selected
definition exactly; legacy files without the reference continue to resolve by
module name when that name is unique. A legacy instance with an ambiguous name
remains unresolved until the author chooses a source definition. This began as
a backward-compatible schema-v1 extension. The current editable model is
schema v2, which retains the definition reference and adds a first-class
`logic` collection; schema-v1 files normalize into that model.

The webview uses one central shortcut dispatcher that calls the same action
functions as toolbar buttons. VS Code commands are not added because the
actions depend on the focused webview's current selection, dialog, and pending
connection state. Keeping one action path prevents button and keyboard behavior
from drifting apart.

## Unconnected Input Defaults

The resolver assigns an implicit default expression `0` to an instance input
when no definite driver, connection default, or explicit design default exists.
Unsized zero is valid Verilog-2005 and naturally extends to the destination
width. Explicit connection defaults and explicit design defaults retain their
existing precedence over the implicit value.

This behavior applies both when an input pin has no connection and when it
belongs to a scalar connection with no driver. It does not apply to an
undriven top-level output; that remains an authoring error because it indicates
that the generated module would not drive its public output.

The implicit default is represented in resolved data with a distinct origin,
not implemented by suppressing `AD_UNDRIVEN_INPUT`. Graph projection does not
turn it into a pseudo constant node; RTL export still emits the corresponding
constant port connection. The Inspector exposes the resolved behavior while
the canvas remains limited to explicitly authored nodes.

Selecting an instance input pin adds a `Default` field to the Inspector. An
empty field means `Implicit default: 0`. Entering a safe Verilog constant
expression stores the existing `setDefault` edit for the endpoint. Clearing an
explicit value removes it and restores implicit zero. Non-input pins do not
show this field.

## Module Selection and Automatic Naming

The Add Instance dialog lists every indexed module definition. Each option
shows the module name and a workspace-relative source path; definitions with
the same name in the same file also show their declaration line. The option
value is the definition identity rather than the module name. This mirrors the
existing Instantiate Module picker and prevents a second module-discovery or
port-parsing implementation.

The selected catalog entry supplies the module name and definition reference
for the `addInstance` edit. The resolver binds the exact definition before
projecting ports, parameters, interfaces, navigation targets, or RTL. If the
referenced definition is no longer available, the instance is reported as
unresolved rather than silently switching to a different same-named module.

The dialog orders the module selector before the instance name. On open and on
module selection changes, it proposes the lowest unused non-negative suffix:

```text
alu  -> u_alu_0
alu  -> u_alu_1
uart -> u_uart_0
```

Counters are derived from existing instance names at proposal time, so deleted
numbers may be reused and persisted counter state is unnecessary. All
definitions named `alu` share the `alu` sequence, regardless of source file.
The proposal continues to track module selection only until the author edits
the name manually. A manually edited valid name is never overwritten.

## Keyboard Shortcuts

The Arch Design webview maps the following keys to existing actions:

| Action | Shortcut |
| --- | --- |
| Search | `Ctrl+F` / `Cmd+F` |
| Next search result | `Enter` while search is active |
| Previous search result | `Shift+Enter` while search is active |
| Add module instance | `A` |
| Add Logic Utility | `L` |
| Add top-level port | `P` |
| Toggle connection mode | `C` |
| Delete selection | `Delete` / `Backspace` |
| Open selected module definition | `Enter` |
| Export RTL | `E` |
| Fit schematic | `F` |
| Reset zoom | `0` |
| Relayout | `R` |
| Toggle minimap | `M` |
| Toggle Inspector | `I` |
| Cancel connection or close the active dialog/search | `Escape` |

Single-key shortcuts run only for an editable Arch Design when focus is not in
an input, select, textarea, contenteditable region, or modal dialog. Existing
search and canvas Enter behavior keeps priority in its local context. The
dispatcher respects disabled controls and pending edits by invoking the shared
action guard rather than synthesizing unconditional edits.

Relevant controls receive `aria-keyshortcuts`. The visible UI remains compact;
this change does not add a help card or shortcut labels to buttons.

## Dependency Refresh

The current full audit reports seven transitive development-dependency
findings: five high and two moderate. `npm audit --omit=dev` reports zero, and
the packaged VSIX does not contain the affected packages. The findings are
primarily beneath the VS Code packaging toolchain, so present end users are not
exposed through the shipped extension.

All seven have compatible patched versions available through a normal
`npm audit fix`. The lockfile will be refreshed without `--force` and without a
major direct dependency change. The resulting tree must satisfy both:

```text
npm audit --omit=dev  -> 0 vulnerabilities
npm audit             -> 0 vulnerabilities
```

The repository build, tests, release checks, VSIX package, and installed-VSIX
smoke test must still pass after the lockfile update.

## Error Handling and Compatibility

- Legacy `.ad` instances containing only `name` and `module` remain valid.
- Unique legacy module names resolve exactly as before.
- Ambiguous legacy module names retain an explicit diagnostic until rebound;
  the editor never guesses a source file.
- A stale explicit definition reference never binds to a different duplicate
  merely because the names match.
- Invalid default expressions continue through the existing safe-expression
  validation and do not reach generated RTL.
- Shortcut handlers do nothing when the corresponding action is unavailable.
- Automatic naming validates the final identifier through the existing Arch
  Design edit and parser rules.

## Testing

Implementation follows test-driven development. Focused coverage includes:

- resolver and validation tests proving undriven instance inputs use implicit
  zero while undriven top-level outputs remain errors;
- graph and RTL tests proving the implicit or overridden constant is visible in
  the Inspector and exported without a derived canvas node;
- Inspector projection and edit tests for setting and clearing an input pin
  default;
- webview tests for per-module `_0` naming, manual-name preservation, shortcut
  focus guards, and action dispatch;
- one duplicate-module scenario proving that selecting different definition
  identities produces the corresponding distinct port sets;
- schema/parser/serializer compatibility tests for new and legacy instances;
- npm audit, workspace tests, release tests, packaging, and VSIX smoke tests.

No separate non-ANSI port regression is added. The shared frontend already has
that coverage, and the reported failure is fully explained by duplicate-name
binding.

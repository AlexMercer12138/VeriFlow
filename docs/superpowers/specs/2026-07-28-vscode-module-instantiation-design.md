# VS Code Module Instantiation Design

## Summary

Add a one-command module instantiation workflow to the VeriFlow VS Code extension. Users can invoke it from the Command Palette or the Verilog/SystemVerilog editor context menu, choose a scanned module, and then either insert a formatted instantiation at the active cursor or copy it to the clipboard.

The new command and the existing VS Code Testbench generator will use the same pure TypeScript formatter so both paths produce identical aligned module instantiations.

## Goals

- Contribute a `VeriFlow: Instantiate Module` command to the Command Palette.
- Add the same command to the editor context menu for Verilog and SystemVerilog documents.
- Select from modules scanned under the workspace root and configured `veriflow.libDirs`.
- Distinguish same-name modules by their source file in the module picker.
- Offer a second action picker with `Insert at Cursor` and `Copy to Clipboard`.
- Generate the requested column-aligned named parameter and port connections.
- Reuse one formatter in the command and the existing VS Code Testbench generator.
- Parse the specifically selected module when one source file contains multiple module declarations.

## Non-Goals

- Do not change the Python desktop application's Testbench generator.
- Do not add completion items, code actions, snippets, or automatic signal declarations.
- Do not infer parent-scope signal names beyond using the selected module's parameter and port names.
- Do not block scanning or instantiation when duplicate module names exist.
- Do not add a popup warning for duplicate module names.

## Architecture

### Shared formatter

Create `veriflow-vscode/src/core/moduleInstantiationFormatter.ts`. It exposes a pure function with no VS Code or file-system dependencies:

```typescript
interface NamedConnection {
    name: string;
    value: string;
}

interface ModuleInstantiationOptions {
    moduleName: string;
    instanceName: string;
    parameters: NamedConnection[];
    ports: NamedConnection[];
    baseIndent?: string;
}

function formatModuleInstantiation(options: ModuleInstantiationOptions): string;
```

The command supplies same-name parameter and port connections. The Testbench generator supplies values configured in its panel. Both paths supply `u_<moduleName>` when no explicit instance name exists.

### Module parsing

Extend `PortParser.parseFile` with an optional target module name. When a name is supplied, the parser locates that declaration and parses only its parameter list, port list, and body. Existing callers that omit the name retain the current first-module behavior.

The new command always passes both the selected source file and module name. The Testbench generator passes its configured `module_name`, fixing ambiguous parsing for multi-module files without changing its public configuration format.

### Command orchestration

Keep VS Code-specific workflow code outside the formatter. The command handler will:

1. Resolve the workspace root and configured library directories.
2. refresh the existing module scan.
3. Build module picker items from the scan result.
4. Parse the selected module by file and module name.
5. Ask whether to insert or copy.
6. Format the instantiation and perform the selected action.

Register the command from `extension.ts` and contribute it through `veriflow-vscode/package.json`. The editor context-menu entry is visible only for Verilog and SystemVerilog language identifiers. Command Palette access remains available independently of the active editor language.

## Module Selection And Duplicates

The picker includes modules found in the workspace root and in `veriflow.libDirs`. Each item uses the module name as its label and a workspace-relative or absolute source path as its description.

For a unique module, the picker has one item. If the scan found the same module name in multiple files, it has one item per file so the source is explicit. Instantiation itself does not show a duplicate warning.

Duplicate detection remains a scan concern. During scanning, VeriFlow writes warning entries containing the module name, source file, and declaration line to the existing output channel. No modal or transient warning popup is added.

## Interaction Flow

The two entry points execute the same command:

- Command Palette: `VeriFlow: Instantiate Module`
- Editor context menu: `Instantiate Module`

After selecting a module, a second Quick Pick offers:

- `Insert at Cursor`
- `Copy to Clipboard`

For insertion, the formatter uses the active line's leading whitespace as its base indentation. The command inserts at the primary cursor, replacing the active selection when one exists. The first generated line must not duplicate indentation already present before the cursor; subsequent lines retain the computed base indentation.

For copying, `baseIndent` is empty, so the copied text starts in column one.

Cancellation at either picker exits without modifying the document or clipboard.

## Formatting Rules

The formatter follows these rules independently for the parameter group and port group:

1. The module-name line and instance-name line start at the same base indentation.
2. Connection rows are indented four spaces relative to that base indentation.
3. The left parenthesis column is based on the longest connection name plus one trailing space.
4. There is exactly one space between `(` and the connection value.
5. The right parenthesis column is based on the longest connection value plus one trailing space.
6. Non-final parameter and port rows end with `),`.
7. The final parameter row ends with `))`, closing the named connection and parameter override list.
8. The final port row ends with `));`, closing the named connection and port list.
9. Parameter order and port order are preserved from the parser or Testbench configuration.
10. Formatting uses spaces, not tabs.

Conceptually, each parameter row is assembled from these aligned segments:

```text
.<parameter name padded to group maximum + 1>
( <parameter value padded to group maximum + 1>
isLast ? )) : ),
```

Port rows use the same three-segment calculation, with `));` for the final suffix.

### Parameterized module

```systemverilog
module_name #(
    .DEPTH ( DEPTH ),
    .WIDTH ( WIDTH ))
u_module_name (
    .clk   ( clk   ),
    .rst_n ( rst_n ));
```

### Module without parameters

```systemverilog
module_name u_module_name (
    .clk   ( clk   ),
    .rst_n ( rst_n ));
```

### Module without ports

Without parameters, emit a single complete statement:

```systemverilog
module_name u_module_name ();
```

With parameters, retain the aligned parameter block and emit `u_module_name ();` on the following line.

## Testbench Integration

The VS Code `TestbenchGenerator` keeps responsibility for collecting parsed ports, resolving configured parameter values, merging signal declarations, and writing the complete Testbench file. Only its DUT instantiation string assembly moves to the shared formatter.

For each configured DUT, it passes:

- the configured module and instance names;
- parsed parameters paired with configured values or parser defaults;
- parsed ports paired with configured signal names or same-name defaults;
- four spaces as `baseIndent` because DUT instances are inside the generated Testbench module.

The existing DUT comment and blank-line separation remain unchanged.

## Error Handling

- No workspace folder: show a concise warning and stop.
- No scanned modules: show a concise informational warning and stop.
- Selected file cannot be read: show an error naming the file and stop.
- Selected module cannot be parsed from that file: show an error naming the module and file and stop.
- Insert selected without an active editor: show a concise warning; do not fall back to clipboard implicitly.
- Clipboard write or editor edit fails: show the underlying operation as failed without changing the other destination.

## Testing

Add focused TypeScript tests for:

- exact parameter and port alignment with different name lengths;
- exact right-parenthesis alignment with different value lengths;
- parameterized and non-parameterized modules;
- modules with no ports;
- base indentation;
- preservation of input order;
- target-module parsing in a file containing multiple modules;
- Testbench output using configured parameter values and port signal names through the shared formatter;
- module picker entries for unique and duplicate module names;
- command and Verilog/SystemVerilog context-menu contributions in `package.json`.

The full VS Code extension compile and existing test suite must remain green.

## Acceptance Criteria

- The command is discoverable from `Ctrl+Shift+P` and the HDL editor context menu.
- Both entry points present the same module and action selection flow.
- Workspace and configured library modules appear in the module picker.
- Same-name modules appear as separate path-qualified choices without an instantiation-time warning popup.
- Scan-time duplicate details remain available in the VeriFlow output channel.
- Inserted text follows the current line indentation; copied text has no base indentation.
- Generated text matches all confirmed spacing, alignment, and closing-suffix rules.
- The VS Code Testbench generator emits its DUT instances through the same formatter.
- Multi-module source files produce parameters and ports for the specifically selected module.
- TypeScript compilation and all extension tests pass.

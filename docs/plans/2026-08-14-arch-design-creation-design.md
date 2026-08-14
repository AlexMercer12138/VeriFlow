# Arch Design Creation Design

## Goal

Make Arch Design creation discoverable in the VS Code extension and scriptable from the Node CLI without duplicating the `.ad` template between products.

## VS Code Navigation

The VeriFlow activity bar contains three views in this order:

1. `Simulation`, the renamed module tree with its existing top selection, dependency analysis, simulation, and waveform commands.
2. `Arch Designs`, a new tree dedicated to `.ad` files and future AD workflows.
3. `Testbench Generator`, unchanged.

The Arch Designs title bar provides create and refresh actions. The tree recursively lists workspace `.ad` files in deterministic path order. Selecting a file opens it with the AD custom editor. File context actions reuse the existing open, validate, and export commands. When no designs exist, a visible `Create Arch Design` welcome action provides the same creation command. The command is also available from the Command Palette.

The tree uses VS Code workspace file APIs and an `.ad` file-system watcher. It does not depend on the HDL module index, so design discovery remains available before module scanning and in workspaces that currently contain no HDL sources.

## VS Code Creation Flow

Creation first prompts for the exported Verilog top-module name and validates it as an HDL identifier. A save dialog then defaults to `<module>.ad` while allowing the user to select any workspace directory. Cancelling either step creates nothing. A successful write immediately opens the new file in the AD custom editor. Existing files are never overwritten without an explicit save-dialog choice, and file-system failures are reported without opening a partial design.

The AD webview toolbar remains the only in-editor location for RTL export. The redundant Validate and Export contributions are removed from the VS Code editor title. Validation remains continuous: the toolbar error and warning counts and the Problems panel present its current results without requiring a manual action. Validate and export commands remain registered for the Command Palette and tree-item context menus. Their handlers accept an optional resource URI so a tree action targets that item while active-editor command invocation remains compatible.

## CLI

The CLI adds:

```text
veriflow ad new MODULE [-o OUTPUT]
```

For example, `veriflow ad new soc_top` creates `soc_top.ad` in the current directory, while `veriflow ad new soc_top -o designs/soc.ad` chooses another location. A missing `.ad` suffix is appended. Missing parent directories are created. The command validates the module name and uses exclusive file creation; an existing target produces an error and is not modified.

The root and `ad` help text list the new action. The command remains non-interactive so it can be used reliably in scripts.

## Shared Core

The schematic core owns a single empty-design text factory built from `createEmptyArchDesign()` and `serializeArchDesign()`. Both the VS Code extension and CLI consume this API instead of embedding JSON literals or maintaining local template files. Template bytes, schema defaults, key ordering, and trailing newline are therefore identical in both products and evolve with the AD schema in one place.

## Error Handling

Invalid module names are rejected before a save dialog or file write. CLI creation reports invalid arguments, inaccessible directories, and existing targets through the normal stderr and nonzero-exit path. VS Code creation reports actionable notifications. Tree discovery tolerates invalid AD contents because listing is based on file identity; parsing and semantic diagnostics remain the responsibility of the editor and validate command.

## Verification

Shared-core tests cover deterministic template generation and parsing round trips. CLI tests cover help and argument compatibility, default and explicit output paths, suffix completion, parent creation, invalid module names, and no-clobber behavior. VS Code tests cover discovery and ordering, empty-state contribution metadata, watcher refresh, create/open behavior, cancellation, URI forwarding from context actions, and the absence of duplicate AD editor-title actions. Workspace TypeScript builds and Node test suites provide final regression coverage; no Python tests are involved.

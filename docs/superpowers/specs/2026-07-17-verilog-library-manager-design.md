# Standalone Verilog Library Manager Design

## Context

VeriFlow already contains Python implementations for Verilog module discovery,
parameter and port parsing, and dependency analysis. The new artifact extracts
the relevant behavior into a single script that can be copied and used without
the VeriFlow package or any third-party dependency.

The script is named `vlib.py` and lives at `scripts/vlib.py` in this repository.
Its managed Verilog repository is initially configured by editing a constant at
the top of the script:

```python
REPOSITORY_ROOT = Path(r"D:\Software\VeriFlow")
INDEX_FILE = REPOSITORY_ROOT / ".verilog_module_index.json"
```

## Goals

- Discover every Verilog and SystemVerilog module under the configured root.
- Persist a deterministic JSON index from module name to relative source path.
- Print a selected module's parameters and ports.
- Print a selected module's transitive module dependencies and source paths.
- Copy a selected module's source, optionally with transitive dependencies and
  included files.
- List indexed modules.
- Report whether the index exists, is compatible, and matches repository
  contents.
- Run with Python 3.8 or newer using only the standard library.

## Non-goals

- Full IEEE Verilog or SystemVerilog parsing.
- Full macro expansion or evaluation of preprocessor conditions.
- Project configuration, simulation, compilation, or waveform management.
- Runtime repository path flags or configuration files in the first version.

## Command-line Interface

The script uses `argparse` and exposes these commands:

```text
python vlib.py index
python vlib.py show <module>
python vlib.py deps <module>
python vlib.py copy <module> <destination> [--with-deps]
python vlib.py list
python vlib.py status
```

### `index`

Recursively scan `REPOSITORY_ROOT` for `.v` and `.sv` files. Strip comments,
find all module declarations, fingerprint each source file, and atomically
write `INDEX_FILE`. A file may define multiple modules. If the same module name
is found in different files, report every conflicting path, return exit code 1,
and leave any existing index unchanged.

### `show <module>`

Load the module path from the JSON index, isolate that module from its source
file, and print two sections:

- Parameters: name, data type, and default value.
- Ports: direction, width expression, and name.

Both ANSI and non-ANSI port declarations are supported. A module in a
multi-module source file is parsed independently from its neighbors.

### `deps <module>`

Resolve the complete transitive module dependency graph using the JSON index.
Print each dependency once with its repository-relative source path. Traverse
dependencies deterministically, guard against cycles, and print `MISSING` for
instantiated modules absent from the index. The requested module itself is not
listed as its own dependency.

### `copy <module> <destination> [--with-deps]`

Without `--with-deps`, copy only the selected module's source file. With the
flag, also copy every unique source file in the transitive dependency graph and
all recursively resolved `` `include `` files. Preserve paths relative to
`REPOSITORY_ROOT` beneath the destination so same-named files from different
directories cannot overwrite one another. Create destination directories as
needed and overwrite existing destination files with the selected repository
versions.

An include is resolved relative to its including file first, then relative to
the repository root. Includes that cannot be resolved are reported as missing;
copy returns exit code 1 after copying all resolvable files.

### `list`

Read the JSON index and print module names in case-sensitive lexical order,
one per line.

### `status`

Check the configured repository and index without modifying either. Report:

- Whether the repository exists and is a directory.
- Whether the index exists and contains a supported schema version.
- Whether the repository path stored in the index matches the configured root.
- Added, modified, and deleted `.v` or `.sv` files since indexing.
- The indexed module and source-file counts when the index is readable.

Return 0 only when the index is present, compatible, and current. Otherwise
return 1.

## Index Format

The index is UTF-8 JSON with stable indentation and sorted keys. Paths stored
under `files` and `modules` are relative to `REPOSITORY_ROOT` and use `/` as the
separator on every platform.

```json
{
  "schema_version": 1,
  "repository_root": "D:/Software/VeriFlow",
  "generated_at": "2026-07-17T12:00:00+08:00",
  "files": {
    "rtl/uart.v": {
      "sha256": "...",
      "modules": ["uart_rx", "uart_tx"]
    }
  },
  "modules": {
    "uart_rx": "rtl/uart.v",
    "uart_tx": "rtl/uart.v"
  }
}
```

SHA-256 fingerprints make status independent of filesystem timestamp
resolution and detect same-size edits reliably. The index file itself is not a
Verilog source and is excluded naturally by extension filtering.

## Internal Structure

Although delivered as one file, the script keeps responsibilities separate:

- Repository helpers validate the configured root, enumerate source files,
  normalize relative paths, read text with tolerant UTF-8 decoding, and hash
  files.
- Verilog preprocessing removes line and block comments while preserving
  quoted strings, and removes conditional-directive lines without choosing a
  preprocessor branch.
- Module parsing locates balanced module headers and matching `endmodule`
  boundaries, then parses parameters and ANSI or non-ANSI ports.
- Dependency parsing removes procedural regions before recognizing
  module-level instantiations, handles optional parameter overrides, and
  filters language keywords and self declarations.
- Index helpers build, validate, atomically write, and load the JSON document.
- Dependency traversal performs deterministic breadth-first traversal and
  returns known dependencies, missing modules, and include files.
- Command handlers format output and convert domain failures into exit codes.

All module-specific operations call a common index lookup helper. They never
rescan the repository to locate a requested module.

## Parsing Boundaries

The extracted parser supports the constructs already handled by VeriFlow's
services and tests:

- Verilog and SystemVerilog source extensions `.v` and `.sv`.
- Multiple modules per file.
- Optional parameter blocks and nested balanced parentheses.
- ANSI and non-ANSI port declarations.
- `parameter` and `localparam` declarations.
- Parameterized, multiline, and generate-region module instantiations.
- Recursive and cyclic module graphs.
- Exclusion of comments, procedural blocks, strings, and language keywords
  from dependency candidates.

The script does not evaluate macros. When conditional branches cannot be
resolved, dependencies from all branches may be reported. This conservative
behavior can over-report a dependency but avoids silently dropping a referenced
indexed module.

## Errors and Exit Codes

- Exit code 0: command completed successfully; for `status`, the index is
  current.
- Exit code 1: repository, index, parsing, lookup, dependency, copy, or
  freshness failure.
- Exit code 2: invalid command-line arguments, produced by `argparse`.

Errors are concise, identify the affected module or path, and are written to
standard error. Query commands do not rebuild or silently repair an index.

## Testing

Add `tests/test_vlib.py`. Tests import `scripts/vlib.py` directly and replace
its repository constants with a temporary fixture repository. Tests use real
files and no parser mocks.

Coverage includes:

- Deterministic index generation for `.v`, `.sv`, and multi-module files.
- Atomic rejection of duplicate module definitions.
- Parameter and ANSI/non-ANSI port output.
- Selection of the correct module within a multi-module file.
- Direct, transitive, missing, generate-region, and cyclic dependencies.
- Copying only a selected source file.
- Copying transitive sources and recursive includes with relative layout.
- Listing modules in deterministic order.
- Status for missing, compatible/current, incompatible, added, modified, and
  deleted source files.
- Command exit codes and diagnostic output.

Implementation follows red-green-refactor: each behavior receives a failing
test before production code is added, and the full project test suite is run
before completion.

## Acceptance Criteria

- `scripts/vlib.py` can be copied out of VeriFlow and run with Python 3.8+
  without installing packages.
- All six requested workflows are available through the documented commands.
- Every module lookup after indexing uses the JSON module mapping.
- Copying with dependencies terminates on cycles and preserves relative paths.
- Status accurately identifies source additions, edits, and removals.
- Existing VeriFlow tests and the new standalone-script tests pass.

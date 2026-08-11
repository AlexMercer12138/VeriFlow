# Arch Design CLI Validation And Export Design

## Scope

This phase exposes the completed Arch Design parser, semantic resolver, and RTL
exporter through two explicit Node CLI commands:

```text
veriflow ad validate DESIGN [-p PROJECT] [-L LIB]
veriflow ad export DESIGN [-p PROJECT] [-L LIB]
                          [-o OUTPUT]
                          [--language verilog|systemverilog]
```

It adds the host-side module scan, path resolution, diagnostics, generated-file
ownership checks, and failure-safe local filesystem writes required by those
commands. It does not add build or simulation auto-export, VS Code Arch Design
editing, interface protocols, Python code, or Python tests.

## Architecture

The CLI remains a thin host adapter. `@veriflow/schematic-core/arch-design`
continues to own `.ad` parsing, semantic validation, deterministic RTL
generation, fingerprints, and generated marker parsing. The existing
`NodeWorkspaceHost` and `WorkspaceHdlIndex` own HDL discovery and parsing. A new
CLI command module coordinates those APIs, and a focused Node runtime helper
owns atomic local filesystem publication.

No generic injected filesystem service is introduced in this phase. A future
VS Code adapter will reuse the same host-neutral parser, validator, exporter,
and marker parser, while using VS Code workspace URIs and filesystem APIs for
its own I/O. The CLI must not duplicate semantic rules or inspect generated RTL
with ad hoc string parsing.

Indexed module summaries are structurally compatible with
`ArchDesignModuleDefinition` and are passed to the shared core in stable index
order. Interfaces and packages are excluded from the module catalog.

## Module Discovery

When `--project` is absent, the CLI recursively scans:

1. the directory containing the input `.ad` file;
2. globally configured library directories;
3. directories supplied through the comma-separated `-L/--lib` option.

When `--project` is present, the CLI recursively scans:

1. the project's root directory;
2. the project's configured library directories;
3. globally configured library directories;
4. directories supplied through `-L/--lib`.

Directories are resolved, filtered to existing directories, and deduplicated
without changing their precedence. Command-line search options affect only the
current operation. Unlike existing project override workflows, neither AD
command modifies the project file or global configuration.

The command installs a SIGINT abort handler around the scan and always disposes
the parser worker and workspace index.

## Parsing, Validation, And Diagnostics

Both commands first read and parse the complete input through
`parseArchDesign()`. Invalid JSON or schema-v1 fields return the parser's sorted
path-aware diagnostics. Unknown positive schema versions are rejected for CLI
validation and export rather than migrated or rewritten.

`ad validate` calls `validateArchDesign()` after the module scan. It writes no
design or RTL files. `ad export` calls `exportArchDesignRtl()` directly after
the same scan, relying on the exporter's owned semantic snapshot rather than a
separate validate-then-generate pair.

Diagnostics use one stable human-readable line per item:

```text
design.ad:$.instances[0].module [AD_MODULE_UNRESOLVED] No module definition is named fifo
```

The displayed design path follows normal CLI path display rules and the core
diagnostic order is preserved. Successful validation prints
`Arch Design: OK`. Successful export prints the resolved output path. Invalid
designs, unsupported schemas, scan errors, output conflicts, and write errors
return exit code 1. Command-line syntax errors return exit code 2.

## Language And Output Resolution

The effective language precedence is:

```text
CLI --language > design export.language > verilog
```

This phase has no project-level Arch Design language setting. Verilog produces
`.v`; SystemVerilog produces `.sv`. An explicit `-o/--output` path must end in
the matching extension, case-insensitively, or the command fails without
writing a file. The output extension never infers or overrides the language.

Output path precedence is:

```text
CLI --output > design export.output > sibling default
```

Relative CLI paths are resolved from the process working directory. A relative
`design.export.output` is resolved from the `.ad` file's directory. With no
configured output, `path/to/soc_top.ad` exports beside the source as
`path/to/soc_top.v` or `path/to/soc_top.sv`. Missing output parent directories
are created recursively only after parsing and generation succeed.

## Ownership And Atomic Publication

An absent target may be created. An existing target may be replaced only when
`parseArchDesignRtlMarker()` recognizes its leading VeriFlow marker. A target
without a marker, with a malformed marker, or containing ordinary hand-written
RTL is rejected. This phase intentionally has no `--force` escape hatch.

Publication writes the complete result into a uniquely named temporary file in
the target directory. For an absent target, the helper publishes without
clobbering a target created concurrently. For a recognized generated target,
the helper checks ownership again immediately before atomically replacing it.
Temporary names are never exposed as successful outputs.

Every error path closes file handles and removes its temporary file. A failed
parse, scan, generation, temporary write, ownership recheck, or replacement
leaves the previous target bytes intact. The helper reports the target path and
underlying cause without printing generated RTL to stdout.

## Verification

Command parser tests cover root and `ad` help, required arguments, option
aliases, language values, and exit codes. Existing CLI command behavior remains
unchanged apart from the intentional addition of `ad` to help and invalid-choice
lists.

AD command tests cover standalone, project, global, and additional library
search roots; project immutability; valid and invalid schema-v1 files; unknown
schemas; missing and duplicate modules; semantic diagnostics; default Verilog
and explicit SystemVerilog; every output-path precedence case; and extension
mismatch rejection.

Filesystem tests cover first publication, replacement of a valid generated
file, refusal of hand-written and malformed-marker targets, a concurrent target
creation, temporary write failure, replacement failure, cleanup, and preservation
of prior target bytes. Generated fixtures retain the core exporter's own syntax
coverage, including optional Icarus checks when installed.

The final gate runs the CLI and shared package tests, the complete Electron and
VS Code suite, VSIX packaging, generated-asset verification, npm package dry
runs, `git diff --check`, and a clean worktree check. The Chinese root README
receives only concise validation and export usage examples.

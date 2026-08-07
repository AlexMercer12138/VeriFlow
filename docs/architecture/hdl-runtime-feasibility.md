# HDL Runtime Feasibility Gate

This document records the Foundation feasibility boundary for the HDL parser
runtime. It does not approve or implement the Plan 2 production parser
migration.

## Stop condition

The migration must stop if any SEA, WASM, wheel, hidden-process, or PyInstaller
gate fails. The approved architecture must then be revised and re-approved
before any Plan 2 work begins. A partial pass is not sufficient.

## Pinned platform and parser inputs

The feasibility target is Windows x64. The builder and parser inputs are pinned
as follows:

| Input | Pinned value |
| --- | --- |
| Node.js SEA builder | 24.14.1 |
| `web-tree-sitter` | 0.26.11 |
| `tree-sitter-systemverilog` | 0.4.0 |
| `PyInstaller` | 6.19.0 |
| `web-tree-sitter.wasm` SHA-256 | `715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc` |
| `tree-sitter-systemverilog.wasm` SHA-256 | `e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d` |

The WASM files are external package inputs. The builder verifies their sizes
and checksums and records them in the runtime manifest before packaging.

## Runtime and packaging contract

- The parser worker uses UTF-8 JSONL over anonymous stdin/stdout pipes.
- The executable is a Node.js SEA produced with `postject`.
- The Python artifact is an installed `py3-none-win_amd64` wheel.
- Runtime files are resolved from the installed distribution with
  `importlib.resources`, including the Python 3.8 backport path.
- Worker startup uses `CREATE_NO_WINDOW`; the Windows test also polls
  `EnumWindows` to prove that no visible top-level window appears.
- PyInstaller collects the installed wheel data, not files from the source
  checkout.
- Strict provenance binds tests and PyInstaller to one exact wheel path and
  SHA-256. It also checks the wheel identity, pip installation source, RECORD,
  and installed core-file bytes.

## Parse evidence

Every feasibility layer parses the canonical source
`module packaged; endmodule` and requires a successful `source_file` response
that contains a module:

1. The source worker unit test calls the parser with the pinned WASM language.
   CI uses the default `require.resolve` paths for both WASM files without
   environment overrides.
2. The real SEA smoke launches `parser-worker.exe` through anonymous pipes.
3. The wheel builder probes the copied worker, and the strict installed-wheel
   tests probe the installed runtime.
4. The hidden-process test performs the same parse while polling
   `EnumWindows`.
5. The PyInstaller executable resolves the installed worker and performs the
   same parse from outside the repository working directory.

## CI-enforced sequence

The `hdl-runtime-feasibility` job in `.github/workflows/ci.yml` is an independent
`windows-latest` gate. Its parser sequence is:

1. Install the workspace with `npm ci`.
2. Run `npm test --workspace @veriflow/parser-worker` against the source worker.
3. Build the SEA with `npm run build:parser`.
4. Launch the real SEA with `node scripts/smoke-parser-probe.mjs`.
5. Build and install the exact worker wheel, export its path and SHA-256, and
   run the strict package tests.
6. Build and run the collected executable with PyInstaller 6.19.0.

These are enforced workflow steps. This document does not claim that the new
job has already run on GitHub-hosted infrastructure. The evidence available at
the time of this change is local Windows evidence from the same commands.

## Current local evidence

The local Windows gate has produced an AMD64 PE (`0x8664`), a hidden worker,
an installed-wheel parse, and a PyInstaller parse. Repeated wheel builds from
independent staged sources produced SHA-256
`1054734e8fe268413f73e38da82746271185b9a38afd03be0a5149c03bac4858`.
That value is evidence for the current pinned builder inputs; changing any
input requires the gate to establish new evidence.

## Windows signing caveat

`postject` modifies the Node.js executable to inject the SEA blob. This makes
the original Node Windows signature invalid and produces a known signature
warning during the feasibility build. Formal distribution must sign the final
injected executable after `postject` completes. The warning does not invalidate
the runtime feasibility result, but an unsigned injected executable is not a
release artifact.

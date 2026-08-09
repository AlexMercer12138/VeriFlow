# HDL Runtime Gate

This document records the current feasibility boundary for the shared HDL
parser runtime. The maintained products consume the TypeScript runtime and the
pinned SystemVerilog WASM grammar directly.

## Pinned inputs

The standalone feasibility target is Windows x64. Reproducible SEA generation
uses these pinned inputs:

| Input | Pinned value |
| --- | --- |
| Node.js SEA builder | 24.14.1 |
| `web-tree-sitter` | 0.26.11 |
| `tree-sitter-systemverilog` | 0.4.0 |
| `web-tree-sitter.wasm` SHA-256 | `715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc` |
| `tree-sitter-systemverilog.wasm` SHA-256 | `e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d` |

The builder verifies the WASM file sizes and checksums before producing the
runtime manifest and SEA preparation blob.

## Runtime contract

- The parser worker uses UTF-8 JSONL over stdin and stdout.
- Requests and responses carry a protocol version and request ID.
- Input limits are enforced by bytes so split UTF-8 and CRLF chunks remain
  deterministic.
- The executable is a Node.js SEA produced with `postject`.
- Source-worker and SEA smoke tests both parse
  `module packaged; endmodule` and require a `source_file` containing a module.

## CI gate

The independent `hdl-runtime-feasibility` job in
`.github/workflows/ci.yml` runs on `windows-latest`:

1. Install the npm workspace with Node.js 24.14.1.
2. Run `npm test --workspace @veriflow/parser-worker`.
3. Build the SEA with `npm run build:parser`.
4. Launch the generated executable with `node scripts/smoke-parser-probe.mjs`.

Any source-worker, WASM integrity, SEA build, or real-process smoke failure
blocks the migration and release path.

## Signing caveat

`postject` modifies the Node.js executable while injecting the SEA blob, so an
original Windows signature does not cover the generated binary. Any future
distribution of that standalone executable must sign the final injected file.
The current SEA is feasibility evidence and is not a published product asset.

# Icarus Verilog-2005 Regression Bridge

The regression bridge runs VeriFlow's native Icarus and built-in Icarus WASM
backends against `ivtest/regress-vlg.list`. It targets IEEE 1364-2005 only;
SystemVerilog is outside this suite.

## Pinned Corpus

`tools/simulation/iverilog-revision.json` pins the repository and exact commit
used to build the published WASM package. The runner verifies that the object
is a commit and exports `ivtest` from that object with `git archive`. The
external checkout's `HEAD` is not used, and generated manifests contain source
paths and options but no copied HDL source.

The pinned list has 1,766 active cases and 1,760 Verilog-2005-eligible cases.
Six entries are excluded because they explicitly select another generation:

| Case | Generation |
| --- | --- |
| `br_gh315` | `-g2005-sv` |
| `br_gh567` | `-g2001` |
| `check_constant_3` | `-g1995` |
| `generate_specify` | `-g2005-sv` |
| `generate_specparam` | `-g2005-sv` |
| `pr1758122` | `-g2001-noconfig` |

Regenerate an inspectable manifest with:

```bash
node scripts/simulation/read-iverilog-regress.mjs \
  --iverilog-root /path/to/iverilog \
  --output /tmp/veriflow-regress-manifest.json
```

## Running

Run the deterministic pull-request shard:

```bash
npm run test:sim-regression -- \
  --iverilog-root /path/to/iverilog \
  --backend native-iverilog,builtin \
  --shard 0/20 \
  --json /tmp/veriflow-regress-results.json
```

This command intentionally exits nonzero for the currently known failure and
mismatches, after writing the complete JSON report. CI passes the reviewed
baseline explicitly:

```bash
npm run test:sim-regression -- \
  --iverilog-root /path/to/iverilog \
  --backend native-iverilog,builtin \
  --shard 0/20 \
  --json /tmp/veriflow-regress-results.json \
  --baseline tools/simulation/iverilog-regression-baseline.json
```

Use `--shard 0/1` for all 1,760 eligible cases. Selection is stable list-order
index modulo the shard count. `--timeout-ms` defaults to 30,000 per case.

The command exits nonzero for bridge/setup errors, unapproved backend failures,
unapproved mismatches, an invalid baseline, or stale approvals. It writes JSON
before applying the result exit status, so CI's `if: always()` upload retains
the evidence. The baseline pins the corpus revision and matches exact failure
and mismatch fields plus SHA-256 digests of the complete stable results. A
failure stores one result digest; a mismatch stores the normalized left and
right result digests. Canonical JSON key ordering makes object insertion order
irrelevant. Timings, approval flags, and digest fields are excluded as derived
or nondeterministic; other present and future result fields are included by
default. The baseline never changes a result from fail to pass. Each raw
failure and mismatch is marked `approved: true` or `approved: false` in the
report. Capability skips remain visible and do not require approval.

Update baseline digests only from a fresh pinned-corpus JSON report after
manually reviewing the actual stdout, stderr, diagnostics, files, cause,
comparison, and both sides of every mismatch. Replacing a digest without that
review defeats the regression gate.

Each case/backend record retains pass, fail, or skip status; exit class; stage
and exit code; termination, signal, and cause details; stdout and stderr order
within each stream; diagnostic text; unexpected generated files; and
comparison details. Cross-backend differences are listed in `mismatches`.

## Result Semantics

- `normal` requires successful execution and either an exact declared output
  comparison or a line containing only `PASSED` (case-insensitive).
- `CE` requires a compile error, `RE` requires a runtime error, and `CO`
  requires compile success without running the native program.
- `gold=` and `diff=` comparisons retain line order and final-newline
  differences. `unordered=` sorts whole lines only.
- Normalization is limited to CRLF/CR line endings, explicitly configured root
  prefixes, and explicitly declared nondeterministic timing patterns. It does
  not sort stdout, rewrite diagnostics, suppress generated files, or hide
  native/WASM differences.

## Explicit Capability Skips

The native backend runs a version check, a real Verilog-2005 compile, and a
real VVP smoke before any corpus case. An executable file alone is insufficient.
The runner prefers an installed `iverilog` and `vvp` pair. If neither is
available, it can construct a temporary flat runtime from a complete Icarus
build tree, including `ivlpp`, `ivl`, `vvp.conf`, `vvp.tgt`, and built VPI
modules. An incomplete build tree is reported as unavailable; the runner does
not fall back to WASM.

The built-in backend also performs a real adapter compile/run smoke. Individual
cases are explicitly skipped when the common adapter contract cannot represent
an Icarus compiler option or for compile-only cases (the adapter exposes
compile-and-run). Declared `diff=` files use required `file` artifacts and a
temporary destination that is always removed. Literal runtime inputs used by
`include`, `$readmemh`, `$readmemb`, `$sdf_annotate`, and read-mode `$fopen`
calls are staged recursively when they exist. Deliberately missing inputs and
write-only outputs are not synthesized. These rules are capability handling,
not output filters.

In the local `0/20` qualification run on 2026-08-26, the build-tree runtime ran
all 88 native cases successfully. Built-in Icarus reported 83 pass, one exact
gold mismatch (`sys_func_task_error`), and four capability skips:

- `br_gh356b` and `pr2829776b`: unsupported `-gspecify` option;
- `br_gh788`: unsupported `-gno-io-range-error` option; and
- `pr1867332`: the common adapter has no compile-only entry.

Two cross-backend differences remain intentionally visible. `pr1065` creates
`work/BBCDBBCD` under native VVP, while the isolated built-in workspace does
not expose unrequested generated files. `sys_func_task_error` names the native
program `vsim` and the built-in virtual program `/.iverilog/program.vvp`, so
the latter does not match the upstream gold file exactly. No filter suppresses
either difference.

Pinned one-case qualification also runs `fread` and `pr2029336` successfully
on both backends. The latter covers a read-mode `$fopen` input and a required
`diff=` output artifact. Cases such as `br_gh209`, which leave an output file
open at simulation end, expose a real native/WASM artifact-flush difference;
they are failures rather than capability skips.

Pull requests run shard `0/20`. The Monday scheduled job runs the complete
1,760-case suite. Both use the same exact baseline, fail on any new or stale
entry, and archive `veriflow-regress-results.json` even on failure.

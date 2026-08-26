# Icarus Verilog-2005 Regression Bridge

The regression bridge runs VeriFlow's native Icarus and built-in Icarus WASM
backends against `ivtest/regress-vlg.list`. It targets IEEE 1364-2005 only;
SystemVerilog is outside this suite.

## Pinned Corpus

`tools/simulation/iverilog-revision.json` pins the repository and exact commit
used for the regression corpus. The runner verifies that the object is a commit
and exports `ivtest` from that object with `git archive`. The external
checkout's `HEAD` is not used, and generated manifests contain source paths and
options but no copied HDL source. The WASM runtime's independently evolving
source revision is read from its packaged `dist/SOURCE.md` and recorded in the
report metadata; it is not assumed to equal the corpus revision.

The pinned list has 1,766 active cases and 1,758 Verilog-2005-eligible cases.
Eight entries are excluded because they explicitly select another generation:

| Case | Generation |
| --- | --- |
| `br_gh315` | `-g2005-sv` |
| `br_gh567` | `-g2001` |
| `check_constant_3` | `-g1995` |
| `generate_specify` | `-g2005-sv` |
| `generate_specparam` | `-g2005-sv` |
| `pr1077` | `-g2` (deprecated alias for Verilog-2001) |
| `pr1758122` | `-g2001-noconfig` |
| `scope2b` | `-g1` (deprecated alias for Verilog-1995) |

The upstream list contains two entries named `pr2792897` and two named
`pr2849783`. The manifest assigns duplicate occurrences stable list-order IDs
(`pr2792897#1`, `pr2792897#2`, `pr2849783#1`, and `pr2849783#2`). A unique
name uses the name itself as its ID. `caseId` is the machine identity throughout
sharding, results, mismatches, digests, and approvals; `caseName` is retained
only for readable output.

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

Use `--shard 0/1` for all 1,758 eligible cases. Selection is stable list-order
index modulo the shard count, so introducing `caseId` does not reshuffle the
existing shards. The runner rejects missing or duplicate manifest IDs before
selecting a shard. `--timeout-ms` defaults to 30,000 per case.

The command exits nonzero for bridge/setup errors, unapproved backend failures,
unapproved mismatches, an invalid baseline, or stale approvals. It writes JSON
before applying the result exit status, so CI's `if: always()` upload retains
the evidence. Baseline schema v2 pins the corpus revision and matches `caseId`,
the readable name, exact failure or mismatch fields, and SHA-256 digests of the
complete stable results. A failure stores one result digest; a mismatch stores
the normalized left and right result digests. Canonical JSON key ordering makes
object insertion order irrelevant. Timings, approval flags, and digest fields
are excluded as derived or nondeterministic; other present and future result
fields are included by default. The baseline never changes a result from fail
to pass. Each raw failure and mismatch is marked `approved: true` or
`approved: false` in the report. Capability skips remain visible and do not
require approval.

The report's root-level `metadata` records Node, platform, architecture, the
VeriFlow Git revision when available, an explicit `veriflowDirty` worktree
flag, and metadata for every selected backend.
Built-in metadata contains the exact `@veriflow/iverilog-wasm` package version
and source revision. Native metadata contains the first non-empty lines from
separate `iverilog -V` and `vvp -V` invocations when available. A failed native
probe still records `available: false`, its reason, and any version observed
before the failure. Metadata is intentionally not copied into case records and
therefore does not enter per-case result digests.
CI installs the distribution's current `iverilog` package rather than claiming
an unavailable immutable apt pin; the recorded native version lines are the
evidence for the version that actually ran.

Update baseline digests only from a fresh pinned-corpus JSON report after
manually reviewing the actual stdout, stderr, diagnostics, files, cause,
comparison, and both sides of every mismatch. Replacing a digest without that
review defeats the regression gate.

Each case/backend record retains its `caseId` and readable `caseName`; pass,
fail, or skip status; exit class; stage and exit code; termination, signal, and
cause details; stdout and stderr order within each stream; diagnostic text;
the ordered combined stdout/stderr stream when the backend can preserve it;
unexpected generated files; and comparison details. Cross-backend differences
are listed in `mismatches` and keyed by `caseId`.

## Result Semantics

- `normal` requires successful execution and either an exact declared output
  comparison or a line containing only `PASSED` (case-insensitive).
- `CE` requires a compile error, `RE` requires a runtime error, and `CO`
  requires compile success without running the native program.
- `gold=` comparisons prefer the ordered combined stdout/stderr stream and fall
  back to stdout followed by stderr only for a backend that cannot preserve
  interleaving. `diff=` comparisons read the declared artifact. Both retain
  line order and final-newline differences. `unordered=` sorts whole lines only.
- Normalization is limited to CRLF/CR line endings, explicitly configured root
  prefixes, and explicitly declared nondeterministic timing patterns. It does
  not sort stdout, rewrite diagnostics, suppress generated files, or hide
  native/WASM differences.

## Explicit Capability Skips

The native backend runs separate `iverilog -V` and `vvp -V` checks, a real
Verilog-2005 compile, and a real VVP smoke before any corpus case. An executable
file alone is insufficient.
The runner prefers an installed `iverilog` and `vvp` pair. If neither is
available, it can construct a temporary flat runtime from a complete Icarus
build tree, including `ivlpp`, `ivl`, `vvp.conf`, `vvp.tgt`, and built VPI
modules. Strict warning mode additionally requires `vvp-s.conf`. An incomplete
build tree is reported as unavailable; the runner does not fall back to WASM.

The built-in backend also performs a real adapter compile/run smoke. Individual
cases are explicitly skipped when the common adapter contract cannot represent
an Icarus compiler option or for compile-only cases (the adapter exposes
compile-and-run). Declared `diff=` files use required `file` artifacts and a
temporary destination that is always removed. Literal runtime inputs used by
`include`, `$readmemh`, `$readmemb`, `$sdf_annotate`, and read-mode `$fopen`
calls are staged recursively when they exist. Deliberately missing inputs and
write-only outputs are not synthesized. These rules are capability handling,
not output filters.

The registry `0.1.3` `0/20` qualification run on 2026-08-26 selected 88 cases.
The build-tree runtime passed all 88 native cases. Built-in Icarus reported 83
passes, no failures, and five capability skips:

- `br_gh356b` and `sdf2`: unsupported `-gspecify` option; and
- `br_gh788`, `pr1723367`, and `pr2001162`: unsupported
  `-gno-io-range-error` option.

The shard's one reviewed cross-backend mismatch remains intentionally visible:
`pr1065` creates `work/BBCDBBCD` under native VVP, while the isolated built-in
workspace does not expose unrequested generated files. A full baseline can be
used for a shard; approvals outside the selected case/backend identities are
out of scope rather than stale, while an approval for a selected result that
changes remains stale.

The complete registry `0.1.3` `0/1` qualification on 2026-08-26 recorded 1,755
native passes with three failures, plus 1,631 built-in passes, 41 failures, and
86 explicit skips. The 44 failure approvals include three cases that fail
identically on both engines, built-in filesystem and artifact limitations,
diagnostic/gold differences, and two deterministic WASM traps. The report
contains 60 reviewed cross-backend mismatches, including diagnostic wording,
stdout scheduling, virtual paths, and unrequested generated files. All 3,516
case/backend digests matched the preceding local-tarball qualification, and the
tracked baseline was mechanically identical to one generated from the registry
report. A second registry full run with that baseline exited zero with no
unapproved or stale entries. These approvals preserve the raw failures and
differences and do not add output filters or convert them into passes.

`sys_func_task_error` confirms that both backends preserve the diagnostic lines
before the final program message in `combinedOutput`. Native matches the gold
file. Built-in retains one reviewed failure and mismatch because its virtual
program is named `/.iverilog/program.vvp` instead of native `vsim`; no ordering
filter or path substitution hides that semantic output difference.

Pinned one-case qualification also runs `fread` and `pr2029336` successfully
on both backends. The latter covers a read-mode `$fopen` input and a required
`diff=` output artifact. Cases such as `br_gh209`, which leave an output file
open at simulation end, expose a real native/WASM artifact-flush difference;
they are failures rather than capability skips.

Pull requests run shard `0/20`. The Monday scheduled job runs the complete
1,758-case suite. Both use the same exact baseline, fail on any new or stale
entry, and archive `veriflow-regress-results.json` even on failure.

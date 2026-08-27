# Verilog Simulator Benchmarks

This corpus measures simulator execution performance independently from the
Icarus compatibility regression suite. Every case is project-authored,
Verilog-2005, bounded, and self-checking. A successful run prints one exact
`PASS <case-id>` line and calls `$finish`.

The benchmark protocol prepares source files before timing. It then:

1. compiles once and records compile wall time;
2. runs one unmeasured warmup by default;
3. records five run-only samples from the compiled program; and
4. records a separate set of end-to-end samples, including source staging,
   compilation, execution, artifact collection, and cleanup.

Native Icarus always compiles with `-g2005`; the `specify` case additionally
uses `-gspecify`. Its run-only metric launches only `vvp`. The built-in backend
calls `compile()` once and measures `run()` only; its end-to-end metric calls
`simulate()`, with `specify: true` only for the matching case. Native
compile+run is never compared against WASM run-only.

`expectedEvents` is a documented workload count defined by each testbench. It
is not an engine-internal scheduler counter. Peak RSS is sampled from the
native child on Linux. Built-in RSS reports `null` because the shared Node
host includes the harness and memory retained by earlier cases; it is not a
valid per-case engine measurement. Unsupported measurements report `null`
rather than substituting a different metric.
Reports record the VeriFlow revision and dirty state when Git is available,
or an explicit provenance-unavailable reason when it is not.

All cases except `vcd-heavy` perform no file I/O. `vcd-heavy` is the separate
trace variant and must return `wave.vcd`; VCD byte counts must remain identical
across measured samples.

| Case | Workload | Expected events |
| --- | --- | ---: |
| `counter` | 100,000 clocked counter updates | 200,004 |
| `arithmetic` | 100,000 64-bit additions | 100,000 |
| `uart` | 1,024 serialized bytes | 20,480 |
| `fifo` | 5,000 FIFO write/read pairs | 10,000 |
| `generate` | 5,000 updates across 64 generated lanes | 320,000 |
| `memory` | 4,096 writes and 4,096 reads | 8,192 |
| `wide-vector` | 5,000 1,024-bit operations | 5,000 |
| `multi-driver` | 20,000 resolved-net updates | 20,000 |
| `udp` | 20,000 UDP truth-table evaluations | 20,000 |
| `specify` | 20,000 specify-path input updates | 20,000 |
| `vcd-heavy` | 10,000 traced 128-bit updates | 10,000 |

Run both reference backends with:

```bash
npm run benchmark:sim -- \
  --backend native-iverilog,builtin \
  --samples 5 \
  --iverilog-root /path/to/iverilog \
  --json /tmp/veriflow-simulator-benchmark.json
```

Performance CI remains informational until machine variance and release
thresholds are calibrated. A failed self-check, timeout, compile error, missing
artifact, or inconsistent VCD size is still a nonzero benchmark result.

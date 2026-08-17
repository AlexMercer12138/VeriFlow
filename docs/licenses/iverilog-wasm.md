# Icarus Verilog WebAssembly corresponding source

VeriFlow 1.4.2 includes `@veriflow/iverilog-wasm` 0.1.2 under
`GPL-2.0-or-later`. The packaged runtime records this corresponding source:

- Repository: https://github.com/AlexMercer12138/iverilog
- Git revision: `19fe69b3ca34f597aaf4c188f4d75a2d6ee6e3d1`

Every release keeps `dist/SOURCE.md` with that same repository and revision in
both delivery paths:

- the npm dependency installed with `@veriflow/simulator-iverilog-wasm`;
- `dist/vendor/iverilog-wasm` inside the VeriFlow VSIX.

Tagged GitHub releases also publish
`iverilog-wasm-source-19fe69b3ca34f597aaf4c188f4d75a2d6ee6e3d1.tar.gz`
beside the npm tarballs and VSIX. `SHA256SUMS.txt` covers all of these release
assets. The source archive includes the repository at the recorded revision,
its recursively recorded submodules, and the WebAssembly build scripts, but no
Git metadata.

To inspect and reproduce the upstream package from a fresh checkout:

```sh
git clone --no-tags https://github.com/AlexMercer12138/iverilog
cd iverilog
git checkout --detach 19fe69b3ca34f597aaf4c188f4d75a2d6ee6e3d1
git submodule update --init --recursive --no-recommend-shallow
make -C wasm clean build package
```

Before publishing a tag, the `gpl-release-review` GitHub Environment is the
legal review gate for the final npm, VSIX, and corresponding-source
distribution. Repository administrators should configure required reviewers
for that environment. This document records release provenance and the review
process; it does not provide legal advice.

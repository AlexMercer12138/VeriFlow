# Routine Release Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make routine VeriFlow releases manual npm and VSCE publications, keep GitHub Releases opt-in for major versions, and prepare version 1.4.5 artifacts.

**Architecture:** The local release script remains the source of truth for version updates, checks, and packaging. GitHub Actions no longer runs on every tag; its release workflow becomes a manually dispatched artifact builder whose GitHub publication step is disabled by default. npm workspace packages remain separately publishable because the CLI depends on their exact versions, while only the CLI tarball and VSIX are exposed as user-facing GitHub binaries.

**Tech Stack:** Node.js 24.14.1+, npm workspaces, VSCE, GitHub Actions, Node test runner.

---

### Task 1: Repair the failing Linux CI regression

**Files:**
- Modify: `packages/hdl-runtime/test/archDesignDefinitionReference.test.ts`
- Modify: `packages/hdl-runtime/src/archDesignDefinitionReference.ts`

1. Construct Windows file URIs explicitly in the tests instead of passing drive-letter paths to the host-dependent `pathToFileURL` implementation.
2. Run the focused hdl-runtime test and confirm the two legacy-reference cases still fail because drive-letter comparison is host-dependent.
3. Normalize encoded and unencoded Windows drive letters in the definition-reference comparison helper.
4. Re-run the hdl-runtime test and the complete shared-package test command.

### Task 2: Make GitHub Releases explicitly opt-in

**Files:**
- Modify: `scripts/lib/iverilog-source.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/licenses/iverilog-wasm.md`

1. Change the workflow contract test to require manual dispatch, a false-by-default GitHub publication input, and only CLI/VSIX user-facing packages.
2. Run the focused workflow test and confirm it fails against the tag-triggered workflow.
3. Update the workflow so routine tags do nothing and a manually dispatched build creates candidates without publishing a GitHub Release unless explicitly requested.
4. Keep corresponding-source generation and legal review on the optional GitHub publication path, then update the provenance documentation.
5. Re-run the workflow contract test.

### Task 3: Prepare version 1.4.5

**Files:**
- Create: `AGENTS.md`
- Modify: `veriflow-vscode/CHANGELOG.md`
- Modify: all workspace `package.json` files, `package-lock.json`, and CLI version contract fixtures through the release updater

1. Document the routine release commands, artifact locations, dependency-safe npm publication order, VSCE publication command, and optional major GitHub release process in `AGENTS.md`.
2. Add the 1.4.5 changelog entry.
3. Run `npm run release -- --update 1.4.5`, then run the full release checks.
4. Build npm tarballs and the VSIX without invoking authenticated publication.
5. Verify versions, artifact contents, checksums, git diff hygiene, and the exact manual publication commands.

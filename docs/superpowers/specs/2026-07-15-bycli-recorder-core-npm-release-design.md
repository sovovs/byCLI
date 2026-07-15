# byCLI Recorder Core npm Release Design

## Goal

Make `@sovovs/bycli-recorder-core` a public npm package and make the published
`@sovovs/bycli` package declare and install it as a normal runtime dependency.
This repairs the `ERR_MODULE_NOT_FOUND` failure in the recorder paths of the
currently published `@sovovs/bycli@2.1.0` package.

## Confirmed failure

- `@sovovs/bycli-recorder-core` returns 404 from both npmjs and npmmirror.
- The `@sovovs/bycli@2.1.0` tarball contains compiled files that import
  `@sovovs/bycli-recorder-core`.
- The main package neither declares that package in `dependencies` nor bundles
  the recorder-core workspace into its tarball.
- A clean installation can run paths that do not load recorder-core, such as
  `bycli --version`, but importing a recorder module fails with
  `ERR_MODULE_NOT_FOUND`.

## Package boundaries

### `@sovovs/bycli-recorder-core@0.1.0`

The existing `packages/recorder-core` workspace remains an independently built
pure-domain package. It continues to contain deterministic recorder logic and
shared types without browser control, HTTP serving, filesystem writes, or
process output.

Its npm metadata will explicitly define:

- Apache-2.0 licensing and repository information;
- Node.js engine compatibility aligned with the main package;
- public scoped-package access;
- a narrow published file set containing compiled output and package
  documentation.

### `@sovovs/bycli@2.1.1`

The main package will declare
`@sovovs/bycli-recorder-core: ^0.1.0` in `dependencies`. Existing source imports
remain unchanged because they already use the recorder-core public package
boundary. npm will resolve the dependency normally instead of relying on the
development workspace symlink.

## Build and publication flow

The release workflow will:

1. install workspace dependencies;
2. build and test recorder-core;
3. build and test the main package;
4. run the package-install smoke test;
5. publish `@sovovs/bycli-recorder-core@0.1.0` with provenance;
6. publish `@sovovs/bycli@2.1.1` with provenance;
7. continue the existing extension and GitHub Release steps.

Publishing recorder-core first prevents a window in which the main package is
available but its required dependency still returns 404. A failed recorder-core
publication must stop the workflow before the main package publication.

## Package-install contract test

An automated release test will build and pack both workspaces, create a clean
temporary npm project, and install both generated tarballs. It will then import
a compiled main-package recorder entry point that transitively loads
`@sovovs/bycli-recorder-core`.

The test must fail against the current package contract and pass only when:

- recorder-core produces an installable tarball with its compiled entry point;
- the main tarball declares the recorder-core runtime dependency;
- a clean Node.js process resolves the dependency without workspace links;
- no source-tree-only path is needed at runtime.

After publication, verification will repeat installation through npmjs and then
npmmirror, check both reported versions, and run the same recorder import smoke
test.

## Versioning

- First public recorder-core release: `0.1.0`.
- Main-package repair release: `2.1.1`.
- Git tag and GitHub Release: `v2.1.1`.

## Existing worktree changes

Uncommitted recorder and Node engine changes that predate this repair are user
work. The implementation must preserve them and stage only files that belong to
this npm publication fix. If a required edit overlaps an existing modification,
the implementation must retain both intents and review the combined diff before
committing.

## Out of scope

- Moving recorder-core back into the main `src` tree.
- Bundling recorder-core implementation into the main package.
- Changing recorder behavior or its public TypeScript API.
- Publishing `dashboard-be`.

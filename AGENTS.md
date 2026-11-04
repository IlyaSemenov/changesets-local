# changesets-local Agent Guide

## Overview

changesets-local is a CLI that releases a Changesets repository, a single package or a monorepo, from the terminal: it versions the packages, publishes them to npm, pushes the release commit and tags, and creates GitHub Releases.

Read [README.md](README.md) completely before changing the command-line interface, package behavior, supported runtimes, or user documentation.

Extend this guide only with stable, non-obvious conventions, architecture, contracts, workflows, and gotchas.
Do not catalog files or restate information evident from their names and locations.

## Scope

- Keep production code in `src/`.
- Name a directory of one concept in the singular, such as `parser/`, and a directory of like items in the plural, such as `rules/`.
- Keep focused module tests beside their source: `foo.test.ts` and `foo.type-test.ts` test `foo.ts`.
- Test each behavior at the lowest level that can check it: a helper directly, a module that combines helpers by its own unit tests.
- Keep integration and package-boundary tests in `tests/`.
- Name runtime tests `*.test.ts` and compile-only type tests `*.type-test.ts`.
- Keep static multi-line test inputs and expected outputs, such as Markdown, in files under a `fixtures/` directory next to the tests that use them.
- Treat the command-line options, the release commit subject `Release a@1.0.0, b@2.0.0`, the Changesets tag formats, the `release:check` script, and supported runtimes as public contracts.

## Architecture

- Write `src/` for Node.js with `node:` APIs only: users run the CLI with `npx`, while Bun only runs the tests.
- Do not add runtime dependencies.
- Delegate versioning, changelog generation, npm publication, and tag creation to the project's own `@changesets/cli` instead of reimplementing them; only create tags that are missing at an existing release commit, as Changesets would.
- Derive release progress from Git, npm, and GitHub in `inspectRelease`; do not persist release state.
- Identify a release by its commit: the newest commit whose subject lists exactly the package versions it changes, in any order. Derive package directories from the `package.json` files that Git reports changed; do not discover workspaces.
- Keep every step after the release commit idempotent and skipped when `inspectRelease` reports it done, so that `--resume` and the main release run the same `finishRelease`.
- Decide that a release is complete only after `inspectRelease` has verified that its tags point to the release commit.
- Push the release commit before publishing to npm, so that a published version always has its commit on the remote.
- Run `assertPublishable` right before every `changeset publish`, not only before the confirmation: Git hooks and `--resume` can change what is published.
- Check npm publish permissions once per run: before the confirmation, or before the push in `--resume`.
- Check CI of the released commit, HEAD before versioning, only in the main release, not in `--resume`.
- Before the release commit, restore the working tree on any failure, unless the user forces an immediate exit with a second Ctrl+C; after a release commit that matches the confirmed release, point the user to `--resume`. A release commit that does not match must be undone, not resumed.
- Never treat missing evidence of a publication as proof that nothing was published; abandoning an incomplete release requires the user's confirmation.
- Run subprocesses that ask for input or take long, such as `changeset publish` and `release:check`, through `runCommand`, which shares the terminal in the CLI.

## Gotchas

- `publishConfig` in `package.json` overrides npm settings from environment variables, so `NPM_CONFIG_PROVENANCE=false` cannot disable `"provenance": true` there; `assertPublishable` rejects it instead.
- Changesets publishes with pnpm in pnpm projects and with npm otherwise, including Bun; npm publishes `workspace:` and `catalog:` specifiers unchanged.
- pnpm 11+ has its own settings, such as `pnpm_config_*` variables and `registries` in pnpm-workspace.yaml, which `npm config` does not see.
- `changeset status --output` reports `changesets: []` not only for dependents of released packages but also for packages of `fixed` groups and on leaving prerelease mode.
- `changeset status --output` reports the highest version of a `fixed` group as `oldVersion` of its packages; read the version of a package from its manifest.
- `changeset publish` publishes every unpublished version of a public package, not only the versions of the current release.
- Changesets 3 defaults `privatePackages` to `{ version: false, tag: false }`, and a boolean sets both.
- `CHANGESETS_OUTPUT` of `changeset publish` reports only `git-tag` events, written after successful publications and for tagged private packages; it does not report failed or skipped publications.
- npm may report a just-published version as missing for several minutes, and then rejects publishing it again as already published.
- `git ls-remote` lists the peeled `^{}` ref of an annotated tag only when it is requested explicitly.

## Design

- With every change, look for refactorings that reduce complexity: duplicated logic, a concept spread over several modules, or code that an upcoming feature will need elsewhere.
  Make those that belong to the change, and propose the others in the final report.
- Give a domain rule or contract its own function or module at its first use, such as how a cache key is built or which values an option accepts, so that the next use finds it.
  Do not extract code that only looks alike.
- Before adding a helper, search for an existing one that does the same.

## Refactoring

- When moving or splitting code, move its tests to follow it.

## Documentation

- Write public README and JSDoc text for package users who do not know the implementation.
- Write user documentation as a guide to using the API in plain terms: what to call and what it does, not how it is typed or implemented.
- Start each section of user documentation from what users want to achieve in their application, such as retrying failed requests, rather than from a description of the package or its concepts.
  Name only a task that users really have; when none fits, state plainly what the API does instead of inventing a task for a "To …" opening.
  Open with a short statement of the common case and its example, and put details, alternatives, and edge cases after the example.
- Other things being equal, write the happy path as an instruction of what to do, such as "Pass the options to `connect`", rather than as a description of the API, such as "`connect` takes options".
  This is a preference, not a rule: keep a description wherever it reads more clearly.
- Do not restate in prose what users see in their editor's types or learn from a TypeScript or runtime error.
- Mention an edge case in user documentation only when users must write different code because of it; cover other edge cases with tests.
- Write a rule that users must follow as an instruction, such as to call `close` before the process exits, rather than as the check or error that enforces it.
- When a change makes an existing statement false, fix that statement rather than add an explanation next to it.
- Add JSDoc to every exported declaration and to internal helpers whose contract, inputs, output, or failure behavior is not obvious.
- Add inline comments beside every non-obvious invariant, algorithmic choice, safety constraint, and intentionally limited behavior.
- Update nearby JSDoc and inline comments whenever the documented code changes, and remove comments that no longer apply.
- Do not narrate self-evident syntax or restate what a name already communicates.
- Do not document obvious or implied defaults.
- Describe a default only when readers need it to make a decision or avoid surprising behavior.
- Use One Sentence Per Line for connected prose.
- Keep semantically connected explanations as prose paragraphs.
- Use lists for separate assertions instead of presenting them as prose paragraphs.

## Changesets

- Add one `.changeset/*.md` file for each independently releasable user-visible change.
- Do not add changesets for internal refactors, maintenance, tests, or documentation changes that do not require a package release.
- Choose the SemVer bump from the public contract: `patch` for backward-compatible fixes, `minor` for backward-compatible functionality, and `major` for breaking changes.
- Create `.changeset/<unique-name>.md` with this format:

```markdown
---
"changesets-local": patch
---

Describe the user-visible change.
```

- Briefly describe the user-observable change or new capability in the public contract, without implementation details or rationale.
  Prefer a single sentence.
- For a fix, describe the problem users saw, not how the fix works:
  - Avoid: "Compare cache keys by the normalized path instead of the raw argument."
  - Prefer: "Fix stale results when the same file is passed through different relative paths."
- Do not edit the package version or `CHANGELOG.md` by hand, and do not run `changeset version`, `changeset publish`, or the `release` script; the maintainer releases with `bun run release`, which runs this package's own CLI.

## Tests

- Test release behavior with the fixtures from `tests/fixture.ts`: a temporary repository with a bare Git remote and fake npm, pnpm, and gh from `tests/fake-tool/` on a restricted PATH.
  Never let tests reach the real npm registry or GitHub; extend the fakes for every new npm, pnpm, or gh command.
- The `test` script runs tests concurrently: keep the state of each test in its own fixture, and do not change process-wide state such as `process.env` or the working directory.

- Add a `describe` block where the file gives a reason for it: several APIs or behaviors in one file, or a fixture that belongs to some cases but not all.
  Name such a block after what it covers and keep its fixtures inside it.
- Distinguish several same-kind values by role rather than by order.
  When values differ only by order, number them with digits instead of ordinal words.
- Keep tests deterministic so a failure repeats on every run.
  Generate random inputs from an explicit seed and print the seed in failure messages so the failing input can be replayed.

## Checks

- Run the `types` script when types or TypeScript configuration change.
- Run the `test` script when behavior changes.
- Run the `build` script when the CLI entry point, bundling, or supported runtimes change.

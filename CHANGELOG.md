# changesets-local

## 1.2.1

### Patch Changes

- 426fe13: Fix releases waiting indefinitely for CI jobs awaiting environment approval.
- 1d92b92: Fix skipped CI checks when releasing immediately after a push.
- f3b1263: Ask about failed CI only when there are pending changesets to release.
- f09a0da: Show which CI checks are still running while a release waits for them.
- 4ec36e4: Retry reading CI checks after a network failure instead of failing the release.
- 4ec36e4: Warn and continue the release instead of failing when the GitHub token cannot read CI checks.

## 1.2.0

### Minor Changes

- b12a6d3: Wait for CI on the released commit before the confirmation, and ask before releasing a commit whose CI has failed.

### Patch Changes

- 40366db: Stop `--dry-run` on another branch from advising to push its commits to the base branch.
- c7cbf7a: Speed up runs in repositories with large lockfiles.
- bbc09ce: Check npm publish permissions once per run.

## 1.1.0

### Minor Changes

- 0fddc40: Make `--dry-run` preview the release of the last commit and warn instead of stopping when the working tree has uncommitted changes, the branch is not in sync with its remote branch, or another branch is checked out.

### Patch Changes

- 3d4b2fd: Tell apart a branch that is behind, ahead of, or diverged from its remote branch, and show the remote branch by its short name, such as `origin/main`.
- dd4e0db: Stop before pushing the release commit when the npm account cannot publish a package or its scope does not exist.
- 7480d67: Fix a false "already published" error for a versioned private package whose name another npm package uses.
- d40af11: Find the release commit faster in repositories with many `Release …` commits of other tools, and recognize a release commit that lists its packages in another order.
- f666384: Describe `--resume` in `--help` as finishing an interrupted release.
- ecbb2f7: Exit at once on a second Ctrl+C, when a subprocess does not stop after the first one.
- e69c57d: List packages in release commit subjects and summaries alphabetically without the `@` of a scope, such as `Release kern-orm@0.1.0, @kern-orm/postgres-js@0.1.0`.
- e405562: Hide the advice of `changeset version` to review and commit the changes while keeping its warnings, and remove an extra blank line from the monorepo release summary.

## 1.0.0

### Major Changes

- 77714c2: Initial release.

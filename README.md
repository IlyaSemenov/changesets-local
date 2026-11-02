# changesets-local

Release [Changesets](https://github.com/changesets/changesets) packages from your terminal with one command: version them, publish them to npm, push the release commit and tags, and create GitHub Releases.

```sh
npx changesets-local
```

You keep writing `.changeset/*.md` files and choosing SemVer bumps as usual.
Instead of the Changesets GitHub Action with its Version pull request and CI publishing, you release on demand from your machine, authenticating to npm interactively with 2FA.

changesets-local is a thin layer over your project's own `@changesets/cli` 3:

- `changeset version` bumps versions and writes changelogs.
- `changeset publish` publishes to npm and creates the Git tags.
- Git pushes the release commit and the tags.
- The GitHub CLI creates a GitHub Release for each tag with the notes of the version from its `CHANGELOG.md`.

It works in single-package repositories and in monorepos with independently versioned packages.
It uses your existing Changesets configuration and changelog conventions.
It checks Git, npm, and GitHub before publishing and can finish an interrupted release.

## Requirements

- A GitHub repository with a single package or with npm, pnpm, or Bun workspaces.
- npm, pnpm, or Bun as the package manager.
- `@changesets/cli` 3 installed as a dev dependency at the repository root, and `.changeset/config.json` with `"commit": false`.
- Node.js ^22.11, ^24, or >=26.
- [GitHub CLI](https://cli.github.com) logged in to an account that can create releases in the repository.
- npm logged in to an account that can publish the packages.
  For a new package in an organization scope, create the npm organization first.

## Log in to npm and GitHub

Log in once; changesets-local checks both logins before changing anything.

```sh
npm login
gh auth login
```

changesets-local never asks for or stores npm passwords, one-time passwords, or tokens: npm asks for them itself when it publishes.

## Release packages

Record user-visible changes with changesets as usual and commit them:

```sh
npx changeset
git add .changeset
git commit -m "Fix login redirect"
git push
```

When you want to release, commit your changes, check out the base branch from `.changeset/config.json`, sync it with its remote branch, and run changesets-local in the repository root:

```sh
npx changesets-local
```

changesets-local versions the packages, runs [`release:check`](#check-the-release-before-publishing), and shows the release before asking for confirmation:

```text
Release my-package@1.5.0
  my-package 1.4.2 → 1.5.0 (minor)

Release notes:
  ### Minor Changes

  - 3f1c2ab: Add the `timeout` option.

  ### Patch Changes

  - 9d0e4f1: Fix login redirect.

Changes:
   .changeset/brave-lions-dance.md |  5 -----
   .changeset/quiet-owls-sing.md   |  5 -----
   CHANGELOG.md                    | 10 ++++++++++
   package.json                    |  2 +-
   4 files changed, 11 insertions(+), 11 deletions(-)

Steps:
  - Commit "Release my-package@1.5.0"
  - Push it to origin/main
  - Publish to npm as alice: my-package@1.5.0 (latest)
  - Create and push tag v1.5.0
  - Create GitHub Release in alice/my-package: v1.5.0

Release my-package@1.5.0? [y/N]
```

After you confirm, it runs the steps in this order.
When npm asks for a one-time password or browser authentication, complete it in the terminal.

If you decline, or versioning or `release:check` fails, changesets-local restores the working tree and nothing is committed.
Ctrl+C before the release commit does the same; after it, the release stops, and you [finish it](#finish-an-interrupted-release) with `--resume`.
Press Ctrl+C again to exit at once without any cleanup.

To preview a release without changing anything, run:

```sh
npx changesets-local --dry-run
```

The dry run checks the repository and logins and shows the release notes, changed files, and steps, but does not update the lockfile or run `release:check`.
It previews the release of the last commit and warns when the working tree has uncommitted changes, the branch is not in sync with its remote branch, or another branch is checked out.

### Monorepos

In a monorepo, one release commit releases every package that the pending changesets version, such as `Release @acme/core@2.1.0, @acme/react@1.4.0`.
Each published package gets a `name@version` tag and its own GitHub Release with the notes from its `CHANGELOG.md`.
Private packages are not published; they are tagged and get GitHub Releases only when `privatePackages.tag` is enabled in the Changesets config.

The confirmation lists exactly what `changeset publish` will publish.
If it would also publish a version outside the release, such as a new public package without a changeset, the release stops before the confirmation; release that package with a changeset or make it private.

With npm or Bun, runtime dependencies between published packages (`dependencies`, `optionalDependencies`, and `peerDependencies`) must use version ranges such as `^1.2.0`: npm publishes `workspace:` and `catalog:` specifiers unchanged, and changesets-local stops when it finds them.
Only pnpm replaces them on publication.
This does not apply to `devDependencies`.

### Prereleases

Enter [Changesets prerelease mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) with `changeset pre enter <tag>` and release as usual.
Changesets chooses the npm dist-tag of each version, usually the prerelease tag; check it in the confirmation.
changesets-local marks the GitHub Releases of prerelease versions as prereleases.

## Check the release before publishing

Add a `release:check` script to the root `package.json` to run linting, type checks, tests, or a build before publishing:

```json
{
  "scripts": {
    "release:check": "npm run lint && npm run test && npm run build"
  }
}
```

changesets-local runs it with your package manager after versioning the packages and before asking for confirmation, and again before publishing when it finishes an interrupted release.
The release stops if it fails.
It must not change tracked files; add files it generates, such as `dist`, to `.gitignore`.

Build packages in their `prepack` or `prepublishOnly` scripts: npm runs them on every publication, including one that finishes an interrupted release from a fresh checkout.

## Finish an interrupted release

npm publication cannot be undone, but the steps after it can fail, for example when the network drops or a push is rejected.
When a release fails after the release commit, fix the cause and run:

```sh
npx changesets-local --resume
```

`--resume` finds the newest release commit, checks the remote branch, npm, the remote tags, and the GitHub Releases of its packages, and shows what is done and what is left.
After you confirm, it performs only the remaining steps, without bumping versions again.
Combine it with `--dry-run` to see the state without changing anything.

A release commit is a commit whose subject, such as `Release a@1.0.0, b@2.0.0`, lists exactly the package versions it changes, in any order, whoever made it.

changesets-local never publishes a version that npm already has, overwrites a tag, or force-pushes.
When the state is inconsistent, for example when a remote tag points to a different commit or a GitHub Release is a draft, it explains the problem and stops.

A newly published version can be missing from the npm registry for several minutes while npm scans it.
If a release stops because npm does not show a version it has accepted, wait a few minutes and resume.

If you start a new release while the previous one is incomplete, changesets-local asks you to resume it first.
If nothing of the incomplete release is on npm or tagged and you have reverted its release commit, it asks whether to abandon that release instead.
Abandon it only if you are sure that npm did not accept any of its versions.

## Why changesets-local

With the [Changesets GitHub Action](https://github.com/changesets/action), a Version pull request collects the version updates, and merging it publishes from CI.
For a library maintained by one or a few people, that is an extra pull request per release and publishing failures that you investigate in CI logs.
Publishing from CI is also hard to bootstrap: npm trusted publishing can only be configured for a package that already exists, so you publish the first version of each new package locally or with an npm token in CI, and then configure its trusted publisher.
In a monorepo, you repeat this for every new package.

[changesets-release-it-plugin](https://github.com/abeforgit/changesets-release-it-plugin) releases Changesets packages from the terminal with release-it, but it depends on Changesets 2 ([#8](https://github.com/abeforgit/changesets-release-it-plugin/issues/8)) and supports a monorepo only when all its packages share one version or only one package is versioned.

Keep the GitHub Action if you need [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which npm generates only in CI, or want releases that do not depend on a maintainer's machine.

## Migrate from the Changesets GitHub Action

1. Delete the `changesets/action` step, or the whole release workflow, and keep your test workflow.
   Remove npm publishing secrets and permissions that only the release used, such as `NPM_TOKEN` or `id-token: write`.
2. Remove `"provenance": true` from `publishConfig` of your packages, if present: npm can only generate provenance in a supported CI environment.
3. Make sure `.changeset/config.json` has `"commit": false`.
4. Close the open Version pull request, if there is one.
5. Release with `npx changesets-local`.

Packages published locally have no [npm provenance attestations](https://docs.npmjs.com/generating-provenance-statements).
changesets-local disables provenance for its publication, so a `provenance=true` setting in your `.npmrc` does not break it.

### Skip CI for release commits

If `release:check` runs the same checks as your CI, you can skip CI jobs for release commits, which `release:check` has verified locally.
Skip them with a job-level condition:

```yaml
jobs:
  test:
    if: ${{ !startsWith(github.event.head_commit.message, 'Release ') }}
    runs-on: ubuntu-latest
    steps:
      # ...
```

Use a job condition rather than `[skip ci]` in the commit message or a workflow-level filter.
GitHub reports a skipped job as successful, while a workflow that does not run leaves required status checks of branch protection pending.

The condition checks the last pushed commit, which is the release commit when changesets-local pushes it.
It also skips other commits whose message starts with `Release `.

## Limitations

- Yarn projects are not supported.
- Packages that publish from `publishConfig.directory` are not supported.
- Only GitHub repositories and the public npm registry are supported.
- The repository must have no other release automation that publishes the same versions.

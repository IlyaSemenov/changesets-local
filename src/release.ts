import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { styleText } from "node:util"

import { extractChangelogEntry } from "./changelog"
import {
  applyChangesets,
  assertChangesetsInstalled,
  type PlannedRelease,
  planRelease,
  publishPackages,
  type PublishPlanEntry,
  readPublishPlan,
} from "./changesets"
import { type Context, logDetail, logDone, logStep, logWarning, ReleaseError } from "./context"
import { readCommand, runCommand } from "./exec"
import {
  createTag,
  fetchRemote,
  getCommitSubject,
  getCurrentBranch,
  getLocalTagCommit,
  getRemoteTagCommits,
  getRemoteUrl,
  getUpstream,
  getWorkTreeRoot,
  isAncestor,
  listChangedPaths,
  listCommitsBySubjectPrefix,
  listTreeDifferences,
  pushCommit,
  pushTags,
  readFileAtRevision,
  resolveCommit,
  stageWorkTree,
  type Upstream,
} from "./git"
import {
  createGitHubRelease,
  getGitHubReleaseState,
  type GitHubReleaseState,
  resolveGitHubRepo,
} from "./github"
import {
  assertCanPublish,
  assertNpmjsRegistry,
  getNpmUser,
  isNpmjsRegistry,
  isVersionPublished,
} from "./npm"
import {
  formatReleaseSubject,
  listCommitVersionChanges,
  listWorkTreeVersionChanges,
  type PackageRelease,
  parseManifest,
  readPackageManifest,
  sortByName,
} from "./packages"
import {
  getLockfileUpdateCommand,
  type Project,
  readProject,
  readReleaseConventions,
  readWorkTreeFiles,
} from "./project"

/** Options of a release run. */
export interface ReleaseOptions {
  /** Shows what would happen without changing files, Git, npm, or GitHub. */
  dryRun?: boolean
  /** Finishes the release of the newest release commit, if it is incomplete, instead of starting a new one. */
  resume?: boolean
}

/** A checked repository ready for a release. */
interface Workspace {
  project: Project
  branch: string
  upstream: Upstream
  /** GitHub repository as `OWNER/REPO`. */
  repo: string
  npmUser: string
}

/** A release commit and the package versions it sets. */
interface FoundRelease {
  commit: string
  subject: string
  packages: PackageRelease[]
}

/** Progress of a package version of a release across npm, Git, and GitHub. */
interface PackageState extends PackageRelease {
  /** Whether npm has the version; always true for private packages, which are not published. */
  published: boolean
  /** Commit of the local tag, or null when there is none or the package is not tagged. */
  localTag: string | null
  /** Commit of the remote tag, or null when there is none or the package is not tagged. */
  remoteTag: string | null
  /** GitHub Release of the tag, or null when the package is not tagged. */
  githubRelease: GitHubReleaseState | null
}

/** Progress of a release across Git, npm, and GitHub. */
interface ReleaseState extends FoundRelease {
  /** Whether the remote branch contains the release commit. */
  pushed: boolean
  packages: PackageState[]
}

/** What a release will do, shown before the confirmation. */
interface ReleaseSummary {
  subject: string
  plan: PlannedRelease[]
  releases: PackageRelease[]
  /** Release notes by package name. */
  notes: Map<string, string>
  publishPlan: PublishPlanEntry[]
  diffStat: string
}

const changelogFile = "CHANGELOG.md"

/** Prefix of release commit subjects, such as `Release a@1.0.0, b@2.0.0`. */
const releaseSubjectPrefix = "Release "

/** Specifiers that npm leaves unchanged on publication and that only pnpm replaces. */
const workspaceSpecifierPrefixes = ["workspace:", "catalog:"]

/**
 * Releases the packages of the current repository.
 *
 * By default, versions the packages from pending changesets, asks for confirmation, and publishes the release.
 * With `resume`, finishes the release of the newest release commit instead, if it is incomplete.
 */
export async function release(ctx: Context, options: ReleaseOptions = {}) {
  const workspace = await prepareWorkspace(ctx, options)
  if (options.resume) {
    await resumeRelease(ctx, workspace, options)
  } else {
    await startRelease(ctx, workspace, options)
  }
}

/**
 * Checks the repository, tools, and logins, and reads what a release needs.
 *
 * A dry run previews the release of HEAD: it reads the project from HEAD and warns about a dirty work tree or another branch instead of failing.
 */
async function prepareWorkspace(ctx: Context, options: ReleaseOptions): Promise<Workspace> {
  logStep(ctx, "Checking the repository")
  const root = await getWorkTreeRoot(ctx)
  if (!root) {
    throw new ReleaseError("The current directory is not in a Git repository.")
  }
  if ((await realpath(root)) !== (await realpath(ctx.cwd))) {
    throw new ReleaseError(`Run changesets-local from the repository root: ${root}`)
  }
  // A dry run previews the release of HEAD, so it reads the project as committed.
  const project = await readProject(
    options.dryRun ? path => readFileAtRevision(ctx, "HEAD", path) : readWorkTreeFiles(ctx.cwd),
  )
  await assertChangesetsInstalled(ctx)

  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    reportProblem(
      ctx,
      options,
      `The working tree has uncommitted changes. Commit or discard them first:\n${formatList(changedPaths)}`,
    )
  }
  const { baseBranch } = project
  const branch = await getCurrentBranch(ctx)
  if (branch !== baseBranch) {
    reportProblem(
      ctx,
      options,
      `Releases are made from ${baseBranch} (baseBranch in .changeset/config.json), but ${branch ? `${branch} is checked out` : "HEAD is detached"}.`,
    )
  }
  const upstream = await getUpstream(ctx, baseBranch)
  if (!upstream) {
    throw new ReleaseError(
      `${baseBranch} does not track a remote branch. Push it with \`git push -u origin ${baseBranch}\`.`,
    )
  }

  if (project.packageManager !== "npm") {
    await readCommand(ctx, project.packageManager, ["--version"])
  }
  const npmUser = await getNpmUser(ctx)
  await assertNpmjsRegistry(ctx, getRegistryTools(project), [])
  const repo = await resolveGitHubRepo(ctx, await getRemoteUrl(ctx, upstream.remote))
  await fetchRemote(ctx, upstream.remote)
  logDone(ctx, `${baseBranch} tracks ${upstream.remote}, npm user ${npmUser}, GitHub ${repo}`)
  return { project, branch: branch ?? "HEAD", upstream, repo, npmUser }
}

/** Fails with a problem that prevents a release, or prints it as a warning in a dry run. */
function reportProblem(ctx: Context, options: ReleaseOptions, message: string) {
  if (!options.dryRun) {
    throw new ReleaseError(message)
  }
  logWarning(ctx, message)
}

async function startRelease(ctx: Context, workspace: Workspace, options: ReleaseOptions) {
  const found = await findRelease(ctx)
  if (found) {
    const previous = await inspectRelease(ctx, workspace, found)
    if (getPendingSteps(previous).length > 0) {
      await confirmAbandonment(ctx, previous, options)
    }
  }

  const syncProblem = await describeSyncProblem(ctx, workspace)
  if (syncProblem) {
    reportProblem(ctx, options, syncProblem)
  }

  if (options.dryRun) {
    await previewRelease(ctx, workspace)
    return
  }
  const plan = await planPendingRelease(ctx, ctx.cwd)

  const { commit, subject, releases } = await createReleaseCommit(ctx, workspace, plan)
  await finishRelease(
    ctx,
    workspace,
    {
      commit,
      subject,
      pushed: false,
      packages: releases.map(release => ({
        ...release,
        published: release.private,
        localTag: null,
        remoteTag: null,
        githubRelease: release.tag ? "missing" : null,
      })),
    },
    { resumed: false },
  )
}

/** Plans the release of the pending changesets in a work tree, and fails when they release nothing. */
async function planPendingRelease(ctx: Context, cwd: string) {
  const plan = await planRelease(ctx, cwd)
  if (plan.length === 0) {
    throw new ReleaseError(
      "No pending changesets release any package. Add one with `npx changeset` and commit it.",
    )
  }
  return plan
}

/** Describes how HEAD differs from the remote base branch, or returns null when they are at the same commit. */
async function describeSyncProblem(ctx: Context, workspace: Workspace) {
  const { branch, upstream } = workspace
  const head = (await resolveCommit(ctx, "HEAD"))!
  const remoteHead = await resolveCommit(ctx, upstream.trackingRef)
  if (head === remoteHead) {
    return null
  }
  if (!remoteHead) {
    return `${upstream.name} does not exist. Push to it with \`git push ${upstream.remote} HEAD:${upstream.mergeRef}\`.`
  }
  if (await isAncestor(ctx, head, remoteHead)) {
    return `${branch} is behind ${upstream.name}. Pull the remote changes first.`
  }
  if (await isAncestor(ctx, remoteHead, head)) {
    return `${branch} has commits that are not pushed to ${upstream.name}. Push them first.`
  }
  return `${branch} and ${upstream.name} have diverged. Reconcile them first.`
}

/**
 * Lets the user abandon an incomplete release that looks reverted, and fails for any other incomplete release.
 *
 * Nothing proves that an abandoned release was not published: npm may hide an accepted upload for a while, so only the user can decide.
 */
async function confirmAbandonment(ctx: Context, state: ReleaseState, options: ReleaseOptions) {
  if (!(await isApparentlyAbandoned(ctx, state))) {
    throw new ReleaseError(
      `The release "${state.subject}" is incomplete:\n${formatState(state)}\nRun \`changesets-local --resume\` to finish it.`,
    )
  }
  ctx.log(
    [
      "",
      `The release "${state.subject}" is incomplete, and HEAD no longer has its versions, as after a revert:`,
      formatState(state),
      "npm does not show its versions, but npm may hide a version it has just accepted while it scans it.",
    ].join("\n"),
  )
  if (options.dryRun) {
    ctx.log("A release would ask whether to abandon it.")
  } else if (!(await ctx.confirm(`Abandon the release "${state.subject}"?`))) {
    throw new ReleaseError("Release cancelled.")
  }
}

/** Checks whether a release shows no sign of publication or tags and HEAD has none of its versions; npm may still hide an accepted version. */
async function isApparentlyAbandoned(ctx: Context, state: ReleaseState) {
  if (state.packages.some(entry => !entry.private && entry.published)) {
    return false
  }
  if (state.packages.some(entry => entry.localTag || entry.remoteTag)) {
    return false
  }
  for (const entry of state.packages) {
    const manifest = parseManifest(
      await readFileAtRevision(ctx, "HEAD", join(entry.dir, "package.json")),
    )
    if (manifest?.version === entry.version) {
      return false
    }
  }
  return true
}

/** Fails when a versioned package already has its tag, or a public one its version on npm. */
async function assertUnreleased(
  ctx: Context,
  workspace: Workspace,
  plan: PlannedRelease[],
  releases: PackageRelease[],
) {
  const { project, upstream } = workspace
  // Private packages are not published, and their names may belong to other packages on npm.
  const publicPackages = releases.filter(entry => !entry.private)
  await assertPackageRegistries(ctx, project, publicPackages)
  const tagged = getTagged(releases)
  const remoteTags = await getRemoteTagCommits(
    ctx,
    upstream.remote,
    tagged.map(entry => entry.tag!),
  )
  for (const entry of tagged) {
    if (remoteTags.has(entry.tag!) || (await getLocalTagCommit(ctx, entry.tag!))) {
      const oldVersion = plan.find(planned => planned.name === entry.name)?.oldVersion
      throw new ReleaseError(
        `Tag ${entry.tag} already exists, but ${entry.name} is at ${oldVersion}.`,
      )
    }
  }
  const published = await Promise.all(
    publicPackages.map(entry => isVersionPublished(ctx, entry.name, entry.version)),
  )
  const entry = publicPackages.find((_, index) => published[index])
  if (entry) {
    throw new ReleaseError(`${entry.name}@${entry.version} is already published on npm.`)
  }
}

/**
 * Versions the packages in the working tree, runs `release:check`, and commits the result after confirmation.
 *
 * Restores the working tree when anything fails before the commit.
 */
async function createReleaseCommit(ctx: Context, workspace: Workspace, plan: PlannedRelease[]) {
  const { project } = workspace
  const subject = formatReleaseSubject(
    plan.map(entry => ({ name: entry.name, version: entry.newVersion })),
  )
  let releases: PackageRelease[]
  try {
    logStep(ctx, "Versioning")
    const versioned = await versionPackages(ctx, workspace, plan, ctx.cwd)
    releases = versioned.releases
    if (project.lockfile) {
      await runCommand(ctx, ...getLockfileUpdateCommand(project.packageManager))
    }
    const publishPlan = await assertPublishable(ctx, workspace, getTagged(releases), ctx.cwd)
    if (project.hasReleaseCheck) {
      await runReleaseCheck(ctx, workspace)
    }

    await stageWorkTree(ctx)
    const diffStat = await readCommand(ctx, "git", ["diff", "--cached", "--stat"])
    printSummary(ctx, workspace, { subject, plan, ...versioned, publishPlan, diffStat })
    if (!(await ctx.confirm(`Release ${formatVersions(releases)}?`))) {
      throw new ReleaseError("Release cancelled.")
    }

    logStep(ctx, "Committing")
    await runCommand(ctx, "git", ["commit", "--quiet", "--message", subject])
  } catch (error) {
    await restoreWorkTree(ctx)
    throw error
  }

  const commit = (await resolveCommit(ctx, "HEAD"))!
  // A Git hook may also have changed the configuration in the commit, which decides its tags.
  const committed = await listCommitVersionChanges(
    ctx,
    await readReleaseConventions(path => readFileAtRevision(ctx, commit, path)),
    commit,
  )
  if (
    (await getCommitSubject(ctx, commit)) !== subject ||
    describeReleases(committed) !== describeReleases(releases)
  ) {
    throw new ReleaseError(
      `The release commit does not match the confirmed release, probably because of a Git hook. It is not pushed; inspect it and undo it with \`git reset --hard HEAD~1\`.`,
    )
  }
  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    throw new ReleaseError(
      `A Git hook changed files after the release commit:\n${formatList(changedPaths)}\nDiscard the changes and run \`changesets-local --resume\`.`,
    )
  }
  return { commit, subject, releases: committed }
}

/**
 * Applies the pending changesets in a work tree and reads the versioned packages and their release notes.
 *
 * Fails when a versioned package is already released; only versioning tells which packages are private and tagged.
 */
async function versionPackages(
  ctx: Context,
  workspace: Workspace,
  plan: PlannedRelease[],
  cwd: string,
) {
  await applyChangesets(ctx, cwd)
  const releases = await listWorkTreeVersionChanges(ctx, workspace.project, cwd)
  const planned = formatVersions(
    plan.map(entry => ({ name: entry.name, version: entry.newVersion })),
  )
  if (formatVersions(releases) !== planned) {
    throw new ReleaseError(
      `\`changeset version\` set ${formatVersions(releases) || "no versions"}, but ${planned} was planned.`,
    )
  }
  await assertUnreleased(ctx, workspace, plan, releases)
  const notes = new Map<string, string>()
  for (const entry of releases) {
    const changelog = await readFile(join(cwd, entry.dir, changelogFile), "utf8").catch(() => "")
    notes.set(entry.name, getReleaseNotes(changelog, entry))
  }
  return { releases, notes }
}

/**
 * Fails unless `changeset publish` in a work tree would publish and tag exactly the given packages, in a way that matches the release.
 *
 * Public packages are expected as publications and tagged private packages as tags only, and the npm user must be able to publish the public ones.
 * Returns the publish plan, which includes the npm dist-tags.
 */
async function assertPublishable(
  ctx: Context,
  workspace: Workspace,
  packages: PackageRelease[],
  cwd: string,
) {
  const { project } = workspace
  const publicPackages = packages.filter(entry => !entry.private)
  for (const entry of publicPackages) {
    const manifest = await readPackageManifest(cwd, entry.dir)
    const where = `${join(entry.dir, "package.json")}`
    if (manifest?.name !== entry.name || manifest.version !== entry.version) {
      throw new ReleaseError(`${where} does not define ${entry.name}@${entry.version}.`)
    }
    const publishConfig = manifest.publishConfig ?? {}
    if (publishConfig.directory !== undefined) {
      throw new ReleaseError(`${where}: publishConfig.directory is not supported.`)
    }
    if (publishConfig.provenance === true) {
      throw new ReleaseError(
        `${where}: remove \`"provenance": true\` from publishConfig; npm generates provenance only in CI.`,
      )
    }
    for (const [key, value] of Object.entries(publishConfig)) {
      if (
        (key === "registry" || key.endsWith(":registry")) &&
        typeof value === "string" &&
        !isNpmjsRegistry(value)
      ) {
        throw new ReleaseError(
          `${where}: publishConfig points to ${value}; only the public npm registry is supported.`,
        )
      }
    }
    if (project.packageManager !== "pnpm") {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        for (const [dependency, specifier] of Object.entries(manifest[field] ?? {})) {
          if (workspaceSpecifierPrefixes.some(prefix => specifier.startsWith(prefix))) {
            throw new ReleaseError(
              `${where}: replace ${dependency}@${specifier} in ${field} with a version range; npm publishes it unchanged.`,
            )
          }
        }
      }
    }
  }
  await assertPackageRegistries(ctx, project, publicPackages)
  await Promise.all(
    publicPackages.map(entry => assertCanPublish(ctx, workspace.npmUser, entry.name)),
  )

  const publishPlan = await readPublishPlan(ctx, cwd)
  const actual = new Set(publishPlan.map(entry => `${entry.kind} ${entry.name}@${entry.version}`))
  const expected = new Set(
    packages.map(
      entry => `${entry.private ? "tag-only" : "publish"} ${entry.name}@${entry.version}`,
    ),
  )
  const unexpected = [...actual].filter(entry => !expected.has(entry))
  const missing = [...expected].filter(entry => !actual.has(entry))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ReleaseError(
      [
        "`changeset publish` would not publish exactly this release:",
        ...unexpected.map(entry => `  - unexpected: ${entry}`),
        ...missing.map(entry => `  - missing: ${entry}`),
        "Unpublished versions of other packages must be released first or made private.",
      ].join("\n"),
    )
  }
  return publishPlan
}

/** Runs `release:check` and fails when it changes the work tree. */
async function runReleaseCheck(ctx: Context, workspace: Workspace) {
  logStep(ctx, "Running release:check")
  const before = await stageWorkTree(ctx)
  await runCommand(ctx, workspace.project.packageManager, ["run", "release:check"])
  const after = await stageWorkTree(ctx)
  if (after !== before) {
    throw new ReleaseError(
      `release:check changed files:\n${formatList(await listTreeDifferences(ctx, before, after))}\nMake it leave tracked files intact and ignore generated files in .gitignore.`,
    )
  }
}

/** Fails unless HEAD is the release commit and the work tree has no changes, so that `changeset publish` publishes the commit. */
async function assertWorkTreeAtCommit(ctx: Context, commit: string) {
  const short = commit.slice(0, 7)
  if ((await resolveCommit(ctx, "HEAD")) !== commit) {
    throw new ReleaseError(
      `HEAD moved past the release commit ${short}. Save later commits on another branch, reset the branch to ${short}, and resume.`,
    )
  }
  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    throw new ReleaseError(
      `The work tree changed after the release commit ${short}:\n${formatList(changedPaths)}\nDiscard the changes and resume.`,
    )
  }
}

/** Discards changes made by an unfinished release; the working tree was clean when the release started. */
async function restoreWorkTree(ctx: Context) {
  // Runs even after Ctrl+C, which aborts the context signal.
  const cleanup = { ...ctx, signal: undefined }
  try {
    await readCommand(cleanup, "git", ["reset", "--quiet", "--hard", "HEAD"])
    await readCommand(cleanup, "git", ["clean", "--quiet", "--force", "-d"])
    logDetail(ctx, "Restored the working tree.")
  } catch (error) {
    ctx.log(`Could not restore the working tree: ${(error as Error).message}`)
  }
}

/** Shows the release that pending changesets would produce, versioning a temporary worktree instead of the project. */
async function previewRelease(ctx: Context, workspace: Workspace) {
  logStep(ctx, "Versioning in a temporary worktree")
  const tempDir = await mkdtemp(join(tmpdir(), "changesets-local-"))
  const tree = join(tempDir, "tree")
  let summary: ReleaseSummary
  try {
    await readCommand(ctx, "git", ["worktree", "add", "--quiet", "--detach", tree, "HEAD"])
    try {
      // Changesets resolves the changelog generator from the project dependencies.
      await symlink(join(ctx.cwd, "node_modules"), join(tree, "node_modules"))
      // Planned from HEAD like the preview, without uncommitted changesets.
      const plan = await planPendingRelease(ctx, tree)
      const versioned = await versionPackages(ctx, workspace, plan, tree)
      const publishPlan = await assertPublishable(
        ctx,
        workspace,
        getTagged(versioned.releases),
        tree,
      )
      // The node_modules symlink is not ignored by a `node_modules/` pattern, which matches only directories.
      await readCommand(ctx, "git", ["add", "--all"], { cwd: tree })
      await readCommand(ctx, "git", ["reset", "--quiet", "--", "node_modules"], { cwd: tree })
      const diffStat = await readCommand(ctx, "git", ["diff", "--cached", "--stat"], { cwd: tree })
      summary = {
        subject: formatReleaseSubject(versioned.releases),
        plan,
        ...versioned,
        publishPlan,
        diffStat,
      }
    } finally {
      // Runs even after Ctrl+C, which aborts the context signal.
      await readCommand({ ...ctx, signal: undefined }, "git", [
        "worktree",
        "remove",
        "--force",
        tree,
      ])
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
  printSummary(ctx, workspace, summary)
  const { project } = workspace
  const skipped = [
    project.lockfile && `${project.lockfile} update`,
    project.hasReleaseCheck && "release:check",
  ].filter(item => typeof item === "string")
  ctx.log(
    `\nDry run: nothing was changed.${skipped.length > 0 ? ` Not run: ${skipped.join(", ")}.` : ""}`,
  )
}

async function resumeRelease(ctx: Context, workspace: Workspace, options: ReleaseOptions) {
  const found = await findRelease(ctx)
  if (!found) {
    throw new ReleaseError("Nothing to resume: no release commit found.")
  }
  const state = await inspectRelease(ctx, workspace, found)
  ctx.log(formatState(state))
  if (getPendingSteps(state).length === 0) {
    logDone(ctx, `"${state.subject}" is completely released.`)
    return
  }
  if (
    state.packages.some(entry => !entry.published) &&
    (await resolveCommit(ctx, "HEAD")) !== state.commit
  ) {
    throw new ReleaseError(
      `npm does not show every version of "${state.subject}", and HEAD has moved past its release commit ${state.commit.slice(0, 7)}. If they were just published, wait a few minutes and resume; otherwise publish them from the release commit manually.`,
    )
  }
  if (options.dryRun) {
    ctx.log("\nDry run: nothing was changed.")
    return
  }
  if (!(await ctx.confirm(`Finish the release "${state.subject}"?`))) {
    throw new ReleaseError("Release cancelled.")
  }
  await finishRelease(ctx, workspace, state, { resumed: true })
}

/**
 * Finds the newest release commit reachable from HEAD.
 *
 * A release commit has a canonical subject that matches the package versions it changes, whoever created it.
 * Other commits, such as manual version bumps and reverts, are skipped.
 */
async function findRelease(ctx: Context): Promise<FoundRelease | null> {
  for (const { hash, subject } of await listCommitsBySubjectPrefix(ctx, releaseSubjectPrefix)) {
    // The conventions of the release commit, not current ones, define its subject and tags.
    const conventions = await readReleaseConventions(path => readFileAtRevision(ctx, hash, path))
    const packages = await listCommitVersionChanges(ctx, conventions, hash)
    if (packages.length > 0 && formatReleaseSubject(packages) === subject) {
      return { commit: hash, subject, packages }
    }
  }
  return null
}

/**
 * Reads the progress of a release from Git, npm, and GitHub.
 *
 * Fails on conflicting tag targets or draft GitHub Releases.
 */
async function inspectRelease(
  ctx: Context,
  workspace: Workspace,
  found: FoundRelease,
): Promise<ReleaseState> {
  await assertPackageRegistries(
    ctx,
    workspace.project,
    found.packages.filter(entry => !entry.private),
  )
  const tags = getTagged(found.packages).map(entry => entry.tag!)
  const [pushed, remoteTags, packages] = await Promise.all([
    isAncestor(ctx, found.commit, workspace.upstream.trackingRef),
    getRemoteTagCommits(ctx, workspace.upstream.remote, tags),
    Promise.all(
      found.packages.map(async entry => ({
        ...entry,
        published: entry.private || (await isVersionPublished(ctx, entry.name, entry.version)),
        localTag: entry.tag ? await getLocalTagCommit(ctx, entry.tag) : null,
        githubRelease: entry.tag
          ? await getGitHubReleaseState(ctx, workspace.repo, entry.tag)
          : null,
      })),
    ),
  ])
  const state: ReleaseState = {
    ...found,
    pushed,
    packages: packages.map(entry => ({
      ...entry,
      remoteTag: entry.tag ? (remoteTags.get(entry.tag) ?? null) : null,
    })),
  }

  const short = state.commit.slice(0, 7)
  for (const entry of state.packages) {
    for (const [where, commit] of [
      ["Local", entry.localTag],
      ["Remote", entry.remoteTag],
    ] as const) {
      if (commit && commit !== state.commit) {
        throw new ReleaseError(
          `${where} tag ${entry.tag} points to ${commit.slice(0, 7)}, not to the release commit ${short}. Resolve the tag manually.`,
        )
      }
    }
    if (entry.githubRelease === "draft") {
      throw new ReleaseError(
        `The GitHub Release ${entry.tag} is a draft. Publish or delete it, then run changesets-local again.`,
      )
    }
  }
  return state
}

/**
 * Runs the remaining release steps: push the release commit, publish to npm, create and push the tags, and create the GitHub Releases.
 *
 * When `resumed`, runs `release:check` before publishing, since build output of the original run may be missing.
 */
async function finishRelease(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  { resumed }: { resumed: boolean },
) {
  const { project, upstream, repo } = workspace
  const tagged = getTagged(state.packages)
  const unpublished = state.packages.filter(entry => !entry.published)
  // Changesets also tags private packages without a tag when it publishes.
  const expectedPublication = [
    ...unpublished,
    ...tagged.filter(entry => entry.private && !entry.localTag && !entry.remoteTag),
  ]
  try {
    // Checked before pushing, so that a release commit that cannot be published stays local.
    if (unpublished.length > 0) {
      if (resumed && project.hasReleaseCheck) {
        try {
          await runReleaseCheck(ctx, workspace)
        } catch (error) {
          await restoreWorkTree(ctx)
          throw error
        }
      }
      await assertPublishable(ctx, workspace, expectedPublication, ctx.cwd)
    }

    // Pushing before the irreversible publication makes sure the published commit is on the remote.
    if (!state.pushed) {
      logStep(ctx, `Pushing the release commit to ${upstream.remote}`)
      await pushCommit(ctx, upstream, state.commit)
    }

    if (unpublished.length > 0) {
      // Checked again right before publishing, since Git hooks of the push can change the work tree.
      await assertWorkTreeAtCommit(ctx, state.commit)
      await assertPublishable(ctx, workspace, expectedPublication, ctx.cwd)
      logStep(ctx, `Publishing ${formatVersions(unpublished)} to npm`)
      const result = await publishPackages(ctx)
      if (!result.succeeded) {
        throw new ReleaseError(
          "`changeset publish` failed. Some versions may have reached npm anyway; resuming checks npm first.",
        )
      }
      for (const entry of unpublished) {
        if (
          !result.tags.includes(entry.tag!) &&
          !(await isVersionPublished(ctx, entry.name, entry.version))
        ) {
          throw new ReleaseError(
            `npm does not show ${entry.name}@${entry.version} after \`changeset publish\`. If it was just published, wait a few minutes before resuming.`,
          )
        }
      }
    }

    // `changeset publish` creates tags after publishing, so they are read again.
    for (const entry of tagged) {
      const localTag = await getLocalTagCommit(ctx, entry.tag!)
      if (!localTag) {
        logStep(ctx, `Creating tag ${entry.tag}`)
        await createTag(ctx, entry.tag!, state.commit)
      } else if (localTag !== state.commit) {
        throw new ReleaseError(
          `Local tag ${entry.tag} does not point to the release commit. Resolve the tag manually.`,
        )
      }
    }

    const unpushedTags = tagged.filter(entry => !entry.remoteTag).map(entry => entry.tag!)
    if (unpushedTags.length > 0) {
      logStep(
        ctx,
        `Pushing ${unpushedTags.length === 1 ? "tag" : "tags"} ${unpushedTags.join(", ")} to ${upstream.remote}`,
      )
      await pushTags(ctx, upstream.remote, unpushedTags)
    }

    for (const entry of tagged.filter(entry => entry.githubRelease === "missing")) {
      logStep(ctx, `Creating GitHub Release ${entry.tag}`)
      const changelog = await readFileAtRevision(ctx, state.commit, join(entry.dir, changelogFile))
      await createGitHubRelease(ctx, repo, {
        tag: entry.tag!,
        notes: getReleaseNotes(changelog ?? "", entry),
        prerelease: isPrerelease(entry.version),
      })
    }
  } catch (error) {
    if (error instanceof ReleaseError) {
      throw new ReleaseError(
        `${error.message}\n\nThe release "${state.subject}" is incomplete. Fix the problem and run \`changesets-local --resume\` to finish it.`,
      )
    }
    throw error
  }
  logDone(ctx, `Released ${formatVersions(state.packages)}.`)
}

function getPendingSteps(state: ReleaseState) {
  const tagged = getTagged(state.packages)
  return [
    ...(state.pushed ? [] : ["push the release commit"]),
    ...state.packages
      .filter(entry => !entry.published)
      .map(entry => `publish ${entry.name}@${entry.version}`),
    ...tagged.filter(entry => !entry.remoteTag).map(entry => `push tag ${entry.tag}`),
    ...tagged
      .filter(entry => entry.githubRelease === "missing")
      .map(entry => `create GitHub Release ${entry.tag}`),
  ]
}

/** Returns the packages of a release that get a Git tag: public packages, and private ones when Changesets tags them. */
function getTagged<T extends PackageRelease>(packages: T[]) {
  return packages.filter(entry => entry.tag !== null)
}

/**
 * Fails unless npm, and pnpm in a pnpm project, use the public npm registry for the given packages.
 *
 * Checked before asking npm about versions, since a scoped registry setting can redirect both the check and the publication.
 */
function assertPackageRegistries(
  ctx: Context,
  project: Project,
  packages: Array<{ name: string }>,
) {
  const scopes = [
    ...new Set(
      packages.flatMap(entry => (entry.name.startsWith("@") ? [entry.name.split("/")[0]!] : [])),
    ),
  ]
  return assertNpmjsRegistry(ctx, getRegistryTools(project), scopes)
}

/** Returns the npm-compatible tools whose registry settings a publication depends on. */
function getRegistryTools(project: Project): Array<"npm" | "pnpm"> {
  return project.packageManager === "pnpm" ? ["npm", "pnpm"] : ["npm"]
}

function getReleaseNotes(changelog: string, entry: { name: string; version: string; dir: string }) {
  const notes = extractChangelogEntry(changelog, entry.version)
  if (!notes) {
    throw new ReleaseError(
      `${join(entry.dir, changelogFile)} has no notes for ${entry.name}@${entry.version}.`,
    )
  }
  return notes
}

function isPrerelease(version: string) {
  return version.includes("-")
}

function printSummary(ctx: Context, workspace: Workspace, summary: ReleaseSummary) {
  const { project, upstream, repo, npmUser } = workspace
  const { releases, publishPlan } = summary
  const tagged = getTagged(releases)
  const publications = sortByName(publishPlan.filter(entry => entry.kind === "publish"))
  ctx.log("")
  ctx.log(styleText("bold", summary.subject))
  ctx.log(
    summary.plan
      .map(entry => `  ${entry.name} ${entry.oldVersion} → ${entry.newVersion} (${entry.type})`)
      .join("\n"),
  )
  ctx.log(`\n${styleText("bold", "Release notes:")}`)
  ctx.log(
    releases
      .map(entry => {
        const notes = summary.notes.get(entry.name)!
        return project.monorepo
          ? `  ${styleText("bold", `${entry.name}@${entry.version}`)}\n${indent(notes, 4)}`
          : indent(notes, 2)
      })
      .join("\n\n"),
  )
  ctx.log(`\n${styleText("bold", "Changes:")}\n${indent(summary.diffStat, 2)}`)
  ctx.log(`\n${styleText("bold", "Steps:")}`)
  ctx.log(
    formatList([
      `Commit "${summary.subject}"`,
      `Push it to ${upstream.name}`,
      ...(publications.length > 0
        ? [
            `Publish to npm as ${npmUser}: ${publications.map(entry => `${entry.name}@${entry.version} (${entry.tag})`).join(", ")}`,
          ]
        : []),
      ...(tagged.length > 0
        ? [
            `Create and push ${tagged.length === 1 ? "tag" : "tags"} ${tagged.map(entry => entry.tag).join(", ")}`,
            `Create ${tagged.length === 1 ? "GitHub Release" : "GitHub Releases"} in ${repo}: ${tagged.map(entry => `${entry.tag}${isPrerelease(entry.version) ? " (prerelease)" : ""}`).join(", ")}`,
          ]
        : []),
    ]),
  )
}

function formatState(state: ReleaseState) {
  const mark = (done: boolean) => (done ? styleText("green", "✔") : styleText("red", "✘"))
  return [
    `  ${mark(true)} Release commit ${state.commit.slice(0, 7)} "${state.subject}"`,
    `  ${mark(state.pushed)} Release commit pushed`,
    ...state.packages
      .filter(entry => !entry.private)
      .map(entry => `  ${mark(entry.published)} ${entry.name}@${entry.version} published to npm`),
    ...getTagged(state.packages).flatMap(entry => [
      `  ${mark(entry.remoteTag !== null)} Tag ${entry.tag} pushed`,
      `  ${mark(entry.githubRelease === "published")} GitHub Release ${entry.tag} created`,
    ]),
  ].join("\n")
}

/** Serializes release packages for comparison. */
function describeReleases(releases: PackageRelease[]) {
  return JSON.stringify(
    releases.map(({ name, version, dir, private: isPrivate, tag }) => [
      name,
      version,
      dir,
      isPrivate,
      tag,
    ]),
  )
}

/** Formats package versions as `a@1.0.0, b@2.0.0` in their given order. */
function formatVersions(packages: Array<{ name: string; version: string }>) {
  return packages.map(entry => `${entry.name}@${entry.version}`).join(", ")
}

function formatList(items: string[]) {
  return items.map(item => `  - ${item}`).join("\n")
}

function indent(text: string, width: number) {
  const prefix = " ".repeat(width)
  return text
    .split("\n")
    .map(line => (line ? `${prefix}${line}` : line))
    .join("\n")
}

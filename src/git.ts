import { type Context, ReleaseError } from "./context"
import { captureCommand, readCommand, runCommand } from "./exec"

/** Branch tracking configuration of the current branch. */
export interface Upstream {
  /** Remote name, such as `origin`. */
  remote: string
  /** Full name of the branch on the remote, such as `refs/heads/main`. */
  mergeRef: string
  /** Local remote-tracking ref, such as `refs/remotes/origin/main`. */
  trackingRef: string
}

/** Returns the root of the Git work tree containing the project, or null outside a repository. */
export async function getWorkTreeRoot(ctx: Context) {
  const result = await captureCommand(ctx, "git", ["rev-parse", "--show-toplevel"])
  return result.code === 0 ? result.stdout.trim() : null
}

/** Lists paths with uncommitted changes, including untracked files. */
export async function listChangedPaths(ctx: Context, cwd = ctx.cwd) {
  // Not trimmed: an entry starts with a status column that can be a space.
  const result = await captureCommand(
    ctx,
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd },
  )
  if (result.code !== 0) {
    throw new ReleaseError(`\`git status\` failed.\n${result.stderr.trim()}`)
  }
  // Each entry is "XY path"; a rename is followed by an extra entry with the original path.
  const entries = result.stdout.split("\0").filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    paths.push(entry.slice(3))
    if (entry[0] === "R" || entry[0] === "C") {
      i++
    }
  }
  return paths.toSorted()
}

/** Returns the checked-out branch name, or null when HEAD is detached. */
export async function getCurrentBranch(ctx: Context) {
  const result = await captureCommand(ctx, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"])
  return result.code === 0 ? result.stdout.trim() : null
}

/** Returns the upstream of a branch, or null when the branch does not track a remote branch. */
export async function getUpstream(ctx: Context, branch: string): Promise<Upstream | null> {
  const remote = await readConfig(ctx, `branch.${branch}.remote`)
  const mergeRef = await readConfig(ctx, `branch.${branch}.merge`)
  if (!remote || remote === "." || !mergeRef) {
    return null
  }
  const trackingRef = await readCommand(ctx, "git", [
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ])
  return { remote, mergeRef, trackingRef }
}

/** Returns the URL of a remote. */
export function getRemoteUrl(ctx: Context, remote: string) {
  return readCommand(ctx, "git", ["remote", "get-url", remote])
}

/**
 * Updates remote-tracking branches of a remote.
 *
 * Tags are not fetched, so diverging local and remote tags cannot fail the fetch; they are compared with `getRemoteTagCommits`.
 */
export function fetchRemote(ctx: Context, remote: string) {
  return readCommand(ctx, "git", ["fetch", "--quiet", "--no-tags", remote])
}

/** Resolves a revision to a commit hash, or returns null when it does not exist. */
export async function resolveCommit(ctx: Context, rev: string) {
  const result = await captureCommand(ctx, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ])
  return result.code === 0 ? result.stdout.trim() : null
}

/** Checks whether a commit is reachable from another revision. */
export async function isAncestor(ctx: Context, commit: string, rev: string) {
  const result = await captureCommand(ctx, "git", ["merge-base", "--is-ancestor", commit, rev])
  return result.code === 0
}

/** Returns the subject line of a commit. */
export function getCommitSubject(ctx: Context, rev: string) {
  return readCommand(ctx, "git", ["log", "-1", "--format=%s", rev])
}

/** A commit with its subject. */
export interface CommitInfo {
  hash: string
  subject: string
}

/** Lists non-merge commits reachable from HEAD whose subject starts with a prefix, newest first. */
export async function listCommitsBySubjectPrefix(
  ctx: Context,
  prefix: string,
): Promise<CommitInfo[]> {
  const output = await readCommand(ctx, "git", [
    "log",
    "--no-merges",
    "--fixed-strings",
    `--grep=${prefix}`,
    "--format=%H%x00%s",
    "HEAD",
  ])
  return output
    .split("\n")
    .map(line => line.split("\0"))
    .filter(([hash, subject]) => hash && subject?.startsWith(prefix))
    .map(([hash, subject]) => ({ hash: hash!, subject: subject! }))
}

/** Lists the files a commit changes compared with its first parent, or all its files for a root commit. */
export async function listCommitPaths(ctx: Context, commit: string) {
  const output = await readCommand(ctx, "git", [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "--name-only",
    "-z",
    commit,
  ])
  return output.split("\0").filter(Boolean)
}

/** Returns the commit a local tag points to, or null when the tag does not exist. */
export function getLocalTagCommit(ctx: Context, tag: string) {
  return resolveCommit(ctx, `refs/tags/${tag}`)
}

/** Returns the commits that tags point to on a remote; tags missing on the remote are absent from the result. */
export async function getRemoteTagCommits(ctx: Context, remote: string, tags: string[]) {
  const commits = new Map<string, string>()
  if (tags.length === 0) {
    return commits
  }
  // The peeled ref of an annotated tag is listed only when requested explicitly.
  const refs = tags.flatMap(tag => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  const output = await readCommand(ctx, "git", ["ls-remote", "--tags", remote, ...refs])
  const hashes = new Map<string, string>()
  for (const line of output.split("\n")) {
    const [hash, name] = line.split("\t")
    if (hash && name) {
      hashes.set(name, hash)
    }
  }
  for (const tag of tags) {
    const commit = hashes.get(`refs/tags/${tag}^{}`) ?? hashes.get(`refs/tags/${tag}`)
    if (commit) {
      commits.set(tag, commit)
    }
  }
  return commits
}

/** Reads a file from a revision, or returns null when the revision or the file does not exist. */
export async function readFileAtRevision(ctx: Context, rev: string, path: string) {
  const result = await captureCommand(ctx, "git", ["show", `${rev}:${path}`])
  return result.code === 0 ? result.stdout : null
}

/** Stages every change in the work tree and returns the hash of the resulting tree. */
export async function stageWorkTree(ctx: Context) {
  await readCommand(ctx, "git", ["add", "--all"])
  return readCommand(ctx, "git", ["write-tree"])
}

/** Lists files that differ between two trees. */
export async function listTreeDifferences(ctx: Context, from: string, to: string) {
  const output = await readCommand(ctx, "git", ["diff-tree", "-r", "--name-only", "-z", from, to])
  return output.split("\0").filter(Boolean)
}

/** Creates an annotated tag with the tag name as its message, as `changeset publish` does. */
export function createTag(ctx: Context, tag: string, commit: string) {
  return runCommand(ctx, "git", ["tag", "--annotate", tag, "--message", tag, commit])
}

/** Pushes a commit to a remote branch without forcing. */
export function pushCommit(ctx: Context, upstream: Upstream, commit: string) {
  return runCommand(ctx, "git", ["push", upstream.remote, `${commit}:${upstream.mergeRef}`])
}

/** Pushes tags to a remote without forcing, all or none. */
export function pushTags(ctx: Context, remote: string, tags: string[]) {
  return runCommand(ctx, "git", [
    "push",
    "--atomic",
    remote,
    ...tags.map(tag => `refs/tags/${tag}:refs/tags/${tag}`),
  ])
}

async function readConfig(ctx: Context, key: string) {
  const result = await captureCommand(ctx, "git", ["config", "--get", key])
  return result.code === 0 ? result.stdout.trim() : null
}

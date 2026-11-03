import { type Context, logWarning, ReleaseError } from "./context"
import { captureCommand, describeFailure, readCommand, runCommand } from "./exec"

/** Arguments that select github.com, the only supported GitHub host, even when gh defaults to an Enterprise host. */
const githubHostArgs = ["--hostname", "github.com"]

/** Repository permissions that allow creating releases. */
const writePermissions = new Set(["ADMIN", "MAINTAIN", "WRITE"])

/**
 * Resolves the GitHub repository of a Git remote URL with the GitHub CLI.
 *
 * When `gh` is not logged in to github.com, runs `gh auth login` if `login` is set, letting gh ask for credentials in the terminal.
 * Fails with instructions when `gh` is not logged in, the remote is not on GitHub, or the user cannot create releases there.
 * Returns the repository as `OWNER/REPO`.
 */
export async function resolveGitHubRepo(
  ctx: Context,
  remoteUrl: string,
  { login }: { login: boolean },
) {
  const args = ["repo", "view", remoteUrl, "--json", "nameWithOwner,viewerPermission"]
  let result = await captureCommand(ctx, "gh", args)
  // Only a missing token is fixed by logging in; other failures, such as an unreachable GitHub or a remote outside GitHub, are reported.
  // `gh auth token` checks only the github.com token, unlike `gh auth status`, which validates every account and fails when GitHub is unreachable.
  if (
    result.code !== 0 &&
    login &&
    (await captureCommand(ctx, "gh", ["auth", "token", ...githubHostArgs])).code !== 0
  ) {
    logWarning(ctx, "GitHub CLI is not logged in.")
    await runCommand(ctx, "gh", ["auth", "login", ...githubHostArgs])
    result = await captureCommand(ctx, "gh", args)
  }
  if (result.code !== 0) {
    throw new ReleaseError(
      [
        `Cannot access the GitHub repository of ${remoteUrl} with the GitHub CLI.`,
        result.stderr.trim(),
        "Log in with `gh auth login` and make sure the remote is a GitHub repository.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  const { nameWithOwner, viewerPermission } = JSON.parse(result.stdout) as {
    nameWithOwner: string
    viewerPermission: string
  }
  if (!writePermissions.has(viewerPermission)) {
    throw new ReleaseError(`Your GitHub account cannot create releases in ${nameWithOwner}.`)
  }
  return nameWithOwner
}

/** State of the GitHub Release of a tag. */
export type GitHubReleaseState = "missing" | "draft" | "published"

/** Returns whether a GitHub Release exists for a tag and whether it is a draft. */
export async function getGitHubReleaseState(
  ctx: Context,
  repo: string,
  tag: string,
): Promise<GitHubReleaseState> {
  const [owner, name] = repo.split("/")
  const query =
    "query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft } } }"
  const output = await readCommand(ctx, "gh", [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `tag=${tag}`,
  ])
  const response = JSON.parse(output) as {
    data: { repository: { release: { isDraft: boolean } | null } }
  }
  const release = response.data.repository.release
  return release === null ? "missing" : release.isDraft ? "draft" : "published"
}

/** Creates a GitHub Release for an existing remote tag, titled with the tag name. */
export function createGitHubRelease(
  ctx: Context,
  repo: string,
  release: { tag: string; notes: string; prerelease: boolean },
) {
  const args = [
    "release",
    "create",
    release.tag,
    "--repo",
    repo,
    "--title",
    release.tag,
    "--notes-file",
    "-",
    "--verify-tag",
  ]
  if (release.prerelease) {
    args.push("--prerelease")
  }
  return runCommand(ctx, "gh", args, { input: release.notes })
}

/** A CI check of a commit: a check run, such as a GitHub Actions job, or a commit status. */
export interface CommitCheck {
  name: string
  /** `waiting` is a check run awaiting approval, such as a deployment to a protected environment. */
  state: "pending" | "waiting" | "success" | "failure"
  /** Page with the check details, if GitHub has one. */
  url: string | null
}

/** Check run conclusions that do not block a release; branch protection accepts them too. */
const passingConclusions = new Set(["success", "neutral", "skipped"])

/**
 * Lists the latest check runs and commit statuses of a commit.
 *
 * A completed check run passes with a conclusion that branch protection accepts and fails with any other, such as `cancelled` or `timed_out`.
 * Fails with `GitHubAccessError` when the token cannot access the checks or the repository.
 */
export async function listCommitChecks(
  ctx: Context,
  repo: string,
  commit: string,
): Promise<CommitCheck[]> {
  const runs = await readJsonLines<{
    name: string
    status: string
    conclusion: string | null
    html_url: string | null
  }>(
    ctx,
    `repos/${repo}/commits/${commit}/check-runs?per_page=100`,
    ".check_runs[] | {name, status, conclusion, html_url}",
  )
  const statuses = await readJsonLines<{
    context: string
    state: string
    target_url: string | null
  }>(
    ctx,
    `repos/${repo}/commits/${commit}/status?per_page=100`,
    ".statuses[] | {context, state, target_url}",
  )
  return [
    ...runs.map(run => ({
      name: run.name,
      state: getCheckRunState(run.status, run.conclusion),
      url: run.html_url,
    })),
    ...statuses.map(status => ({
      name: status.context,
      state: getStatusState(status.state),
      url: status.target_url || null,
    })),
  ]
}

function getCheckRunState(status: string, conclusion: string | null): CommitCheck["state"] {
  if (status === "waiting") {
    return "waiting"
  }
  if (status !== "completed") {
    return "pending"
  }
  return conclusion !== null && passingConclusions.has(conclusion) ? "success" : "failure"
}

/** Maps a commit status state, which is `error` or `failure` when it fails. */
function getStatusState(state: string): CommitCheck["state"] {
  return state === "pending" || state === "success" ? state : "failure"
}

/** A failure of a GitHub API request that GitHub refused, such as for a token without access to the resource. */
export class GitHubAccessError extends ReleaseError {
  override name = "GitHubAccessError"
}

/**
 * Reads every page of a GitHub REST API list and returns the items that a jq filter selects.
 *
 * Fails with `GitHubAccessError` when GitHub refuses access with 403 or 404, and with `ReleaseError` on other failures, such as network errors and exceeded rate limits.
 */
async function readJsonLines<T>(ctx: Context, endpoint: string, filter: string) {
  const args = ["api", "--paginate", endpoint, "--jq", filter]
  const result = await captureCommand(ctx, "gh", args)
  if (result.code !== 0) {
    // `gh api` reports HTTP errors as `gh: <message> (HTTP <status>)`; GitHub also answers 403 when a rate limit is exceeded.
    const denied = /\(HTTP 40[34]\)/.test(result.stderr) && !/rate limit/i.test(result.stderr)
    const ErrorClass = denied ? GitHubAccessError : ReleaseError
    throw new ErrorClass(describeFailure("gh", args, result))
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

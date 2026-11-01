import { type Context, ReleaseError } from "./context"
import { captureCommand, readCommand, runCommand } from "./exec"

/** Repository permissions that allow creating releases. */
const writePermissions = new Set(["ADMIN", "MAINTAIN", "WRITE"])

/**
 * Resolves the GitHub repository of a Git remote URL with the GitHub CLI.
 *
 * Fails with instructions when `gh` is not logged in, the remote is not on GitHub, or the user cannot create releases there.
 * Returns the repository as `OWNER/REPO`.
 */
export async function resolveGitHubRepo(ctx: Context, remoteUrl: string) {
  const result = await captureCommand(ctx, "gh", [
    "repo",
    "view",
    remoteUrl,
    "--json",
    "nameWithOwner,viewerPermission",
  ])
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

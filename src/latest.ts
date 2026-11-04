// Which GitHub Release of a monorepo gets the `Latest` mark.
import type { Context } from "./context"
import {
  getRemoteTagCommits,
  listCommitTreePaths,
  listTrackedManifestPaths,
  readFileAtRevision,
} from "./git"
import {
  getReleaseTag,
  isManifestPath,
  isPrerelease,
  type PackageRelease,
  parseManifest,
} from "./packages"
import {
  getWorkTreeFiles,
  readReleaseConventions,
  type ReleaseConventions,
  type RepoFileReader,
} from "./project"

/** GitHub repository as `OWNER/REPO` and the Git remote that holds its tags. */
export interface MainPackageRepo {
  repo: string
  remote: string
}

/**
 * Finds the main package of a versioned work tree, for showing what a release will do before its commit exists.
 *
 * See `findMainPackage` for what counts as the main package.
 */
export async function findWorkTreeMainPackage(
  ctx: Context,
  target: MainPackageRepo,
  conventions: ReleaseConventions,
  packages: PackageRelease[],
  cwd: string,
) {
  return findMainPackage(ctx, target, {
    conventions,
    packages,
    manifestPaths: await listTrackedManifestPaths(ctx, cwd),
    read: getWorkTreeFiles(cwd).read,
  })
}

/**
 * Finds the main package at a release commit.
 *
 * Reads the commit because HEAD can move past it before `--resume`.
 * See `findMainPackage` for what counts as the main package.
 */
export async function findCommitMainPackage(
  ctx: Context,
  target: MainPackageRepo,
  release: { commit: string; packages: PackageRelease[] },
) {
  const read: RepoFileReader = path => readFileAtRevision(ctx, release.commit, path)
  return findMainPackage(ctx, target, {
    conventions: await readReleaseConventions(read),
    packages: release.packages,
    manifestPaths: (await listCommitTreePaths(ctx, release.commit)).filter(isManifestPath),
    read,
  })
}

/**
 * Finds the main package of a monorepo: the one named after the GitHub repository.
 *
 * A package outside the release counts only when the remote has the tag of its current version.
 * That leaves out an untagged private root package named after the repository, which is common, and packages that were never released.
 * Asks the remote because a clone can miss older local tags.
 * Returns null when there is no such package or the repository has a single package.
 */
async function findMainPackage(
  ctx: Context,
  { repo, remote }: MainPackageRepo,
  source: {
    conventions: ReleaseConventions
    packages: PackageRelease[]
    manifestPaths: string[]
    read: RepoFileReader
  },
) {
  const { conventions, packages, manifestPaths, read } = source
  if (!conventions.monorepo) {
    return null
  }
  const name = repo.split("/")[1]!
  if (packages.some(entry => entry.name === name && entry.tag !== null)) {
    return name
  }
  for (const path of manifestPaths) {
    const manifest = parseManifest(await read(path))
    if (manifest?.name !== name) {
      continue
    }
    const tag = getReleaseTag(conventions, {
      name,
      version: manifest.version,
      private: manifest.private === true,
    })
    if (tag && (await getRemoteTagCommits(ctx, remote, [tag])).has(tag)) {
      return name
    }
  }
  return null
}

/**
 * Returns how a GitHub Release should set the `Latest` mark: take it, leave it where it is, or, when undefined, let GitHub decide.
 *
 * Other packages leave the mark even when the main package is outside the release, so that it stays on the previous release of the main package.
 * GitHub never marks a prerelease as `Latest`, so a prerelease needs no choice.
 */
export function getLatestMark(
  release: { name: string; version: string },
  mainPackage: string | null,
) {
  if (mainPackage === null || isPrerelease(release.version)) {
    return undefined
  }
  return release.name === mainPackage
}

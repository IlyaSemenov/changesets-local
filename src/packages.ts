import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Context } from "./context"
import { listChangedPaths, listCommitPaths, readFileAtRevision } from "./git"
import type { ReleaseConventions } from "./project"
import { compareCodePoints } from "./strings"

/** Fields of a package `package.json` that releases depend on. */
export interface Manifest {
  name: string
  version: string
  private?: boolean
  publishConfig?: Record<string, unknown>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** A package version that a release produces. */
export interface PackageRelease {
  name: string
  version: string
  /** Version in the previous manifest, or null when the package is new. */
  oldVersion: string | null
  /** Package directory relative to the project root; empty for the root package. */
  dir: string
  private: boolean
  /** Git tag of the version, or null for a private package that Changesets does not tag. */
  tag: string | null
}

/**
 * Lists the packages whose version the work tree changes compared with HEAD.
 *
 * Package directories come from the changed `package.json` files, so no workspace discovery is needed after `changeset version`.
 */
export async function listWorkTreeVersionChanges(
  ctx: Context,
  conventions: ReleaseConventions,
  cwd = ctx.cwd,
) {
  const paths = (await listChangedPaths(ctx, cwd)).filter(isManifestPath)
  return listVersionChanges(conventions, paths, {
    readNew: path => readFile(join(cwd, path), "utf8").catch(() => null),
    readOld: path => readFileAtRevision(ctx, "HEAD", path),
  })
}

/**
 * Lists the packages whose version a commit changes compared with its first parent.
 *
 * Pass the conventions of the repository at that commit, so that later configuration changes do not change its tags.
 * In a root commit, every package is new.
 */
export async function listCommitVersionChanges(
  ctx: Context,
  conventions: ReleaseConventions,
  commit: string,
) {
  const paths = (await listCommitPaths(ctx, commit)).filter(isManifestPath)
  return listVersionChanges(conventions, paths, {
    readNew: path => readFileAtRevision(ctx, commit, path),
    readOld: path => readFileAtRevision(ctx, `${commit}^`, path),
  })
}

/** Returns the Git tag of a package version, following the Changesets conventions, or null for an untagged private package. */
export function getReleaseTag(
  conventions: ReleaseConventions,
  release: Pick<PackageRelease, "name" | "version" | "private">,
) {
  if (release.private && !conventions.tagPrivatePackages) {
    return null
  }
  return conventions.monorepo ? `${release.name}@${release.version}` : `v${release.version}`
}

/** Start of every release commit subject. */
export const releaseSubjectPrefix = "Release "

/** Formats the subject of a release commit, such as `Release a@1.0.0, b@2.0.0`, with packages sorted by name. */
export function formatReleaseSubject(releases: Array<{ name: string; version: string }>) {
  return `${releaseSubjectPrefix}${sortByName(releases)
    .map(release => `${release.name}@${release.version}`)
    .join(", ")}`
}

/**
 * Parses the package versions that a subject in the format of `formatReleaseSubject` lists, in any order.
 *
 * Returns null for other subjects, such as `Release 1.2.3` of other release tools.
 */
export function parseReleaseSubject(
  subject: string,
): Array<{ name: string; version: string }> | null {
  if (!subject.startsWith(releaseSubjectPrefix)) {
    return null
  }
  const versions: Array<{ name: string; version: string }> = []
  for (const item of subject.slice(releaseSubjectPrefix.length).split(", ")) {
    // A package name, possibly scoped such as `@acme/core`, then `@` and a version.
    const match = /^((?:@[^\s@/,]+\/)?[^\s@/,]+)@(\d[^\s@,]*)$/.exec(item)
    if (!match) {
      return null
    }
    versions.push({ name: match[1]!, version: match[2]! })
  }
  return versions
}

/**
 * Sorts packages by name, the order of release commit subjects.
 *
 * Names are compared in code point order without the `@` of a scope, so that a scoped package such as `@kern-orm/postgres-js` follows `kern-orm`.
 */
export function sortByName<T extends { name: string }>(items: T[]) {
  return items.toSorted(
    (a, b) =>
      compareCodePoints(a.name.replace(/^@/, ""), b.name.replace(/^@/, "")) ||
      compareCodePoints(a.name, b.name),
  )
}

/** Parses a `package.json`, or returns null when it is not a package manifest with a name and a version. */
export function parseManifest(content: string | null): Manifest | null {
  if (content === null) {
    return null
  }
  try {
    const manifest = JSON.parse(content) as Partial<Manifest>
    return typeof manifest.name === "string" && typeof manifest.version === "string"
      ? (manifest as Manifest)
      : null
  } catch {
    return null
  }
}

/** Returns the package directory of a `package.json` path, in the format of `PackageRelease.dir`. */
export function getManifestDir(path: string) {
  return dirname(path) === "." ? "" : dirname(path)
}

/** Reads the manifest of a package in a work tree. */
export async function readPackageManifest(cwd: string, dir: string) {
  return parseManifest(await readFile(join(cwd, dir, "package.json"), "utf8").catch(() => null))
}

/**
 * Reads the manifest that a package had when its version was released, from the Git tag of that version.
 *
 * Returns null when the tag is missing or does not have the manifest at this path, such as after the package has moved.
 */
export async function readTaggedManifest(
  ctx: Context,
  conventions: ReleaseConventions,
  manifest: Manifest,
  dir: string,
) {
  const tag = getReleaseTag(conventions, {
    name: manifest.name,
    version: manifest.version,
    private: manifest.private === true,
  })
  if (!tag) {
    return null
  }
  return parseManifest(await readFileAtRevision(ctx, `refs/tags/${tag}`, join(dir, "package.json")))
}

async function listVersionChanges(
  conventions: ReleaseConventions,
  paths: string[],
  read: {
    readNew: (path: string) => Promise<string | null>
    readOld: (path: string) => Promise<string | null>
  },
): Promise<PackageRelease[]> {
  const releases: PackageRelease[] = []
  for (const path of paths) {
    const dir = getManifestDir(path)
    // A single-package repository releases only its root package.
    if (!conventions.monorepo && dir !== "") {
      continue
    }
    const manifest = parseManifest(await read.readNew(path))
    const oldVersion = parseManifest(await read.readOld(path))?.version ?? null
    if (!manifest || manifest.version === oldVersion) {
      continue
    }
    const release = {
      name: manifest.name,
      version: manifest.version,
      oldVersion,
      dir,
      private: manifest.private === true,
    }
    releases.push({ ...release, tag: getReleaseTag(conventions, release) })
  }
  return sortByName(releases)
}

/** Checks whether a path from the repository root is a `package.json` file. */
export function isManifestPath(path: string) {
  return path === "package.json" || path.endsWith("/package.json")
}

import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import { ReleaseError } from "./context"
import { parseJsonContent } from "./json"

/** Reads a file by its path from the repository root, or resolves to null when the file does not exist. */
export type RepoFileReader = (path: string) => Promise<string | null>

/** Access to the files of a repository, in the work tree or at a commit, by their paths from the repository root. */
export interface RepoFiles {
  read: RepoFileReader
  /** Checks whether a file exists without reading it, for large files such as lockfiles. */
  exists: (path: string) => Promise<boolean>
}

/** Returns access to the files of a work tree. */
export function getWorkTreeFiles(cwd: string): RepoFiles {
  const ignoreMissing =
    <T>(missing: T) =>
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return missing
      }
      throw error
    }
  return {
    read: path => readFile(join(cwd, path), "utf8").catch(ignoreMissing(null)),
    exists: path => access(join(cwd, path)).then(() => true, ignoreMissing(false)),
  }
}

/** Package managers whose projects can be released. */
export type PackageManager = "npm" | "pnpm" | "bun"

/** Repository settings that determine release commit subjects and tags. */
export interface ReleaseConventions {
  /** Whether the repository is a monorepo; otherwise the root package is the only released package. */
  monorepo: boolean
  /** Whether Changesets tags private packages: `privatePackages.tag` of the Changesets config. */
  tagPrivatePackages: boolean
}

/** The released repository and its release configuration. */
export interface Project extends ReleaseConventions {
  /** Whether `package.json` defines the `release:check` script. */
  hasReleaseCheck: boolean
  packageManager: PackageManager
  /** Lockfile name, or undefined when the project has none. */
  lockfile: string | undefined
  /** Branch that releases are made from: `baseBranch` of the Changesets config. */
  baseBranch: string
}

/** Fields of `package.json` used to validate the project. */
interface PackageJson {
  name?: unknown
  version?: unknown
  private?: unknown
  workspaces?: unknown
  packageManager?: unknown
  scripts?: Record<string, unknown>
  publishConfig?: Record<string, unknown>
}

/** Fields of `.changeset/config.json` used to validate the project. */
interface ChangesetsConfig {
  baseBranch?: unknown
  changelog?: unknown
  commit?: unknown
  privatePackages?: unknown
}

const lockfiles: Array<[file: string, packageManager: PackageManager | "yarn"]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
]

/** Reads the repository configuration from its files, in the work tree or at a commit, and fails with an explanation when its layout is not supported. */
export async function readProject(files: RepoFiles): Promise<Project> {
  const packageJson = parseJsonContent<PackageJson>(
    await files.read("package.json"),
    "package.json",
  )
  if (!packageJson) {
    throw new ReleaseError("changesets-local requires package.json at the repository root.")
  }
  const conventions = await readReleaseConventions(files.read)
  if (!conventions.monorepo) {
    if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
      throw new ReleaseError("package.json must define the package name and version.")
    }
    if (packageJson.private === true) {
      throw new ReleaseError(
        `${packageJson.name} is private. Remove \`"private": true\` from package.json to publish it to npm.`,
      )
    }
  }

  const config = parseJsonContent<ChangesetsConfig>(
    await files.read(".changeset/config.json"),
    ".changeset/config.json",
  )
  if (!config) {
    throw new ReleaseError(
      "No .changeset/config.json. Set up Changesets with `npx changeset init`.",
    )
  }
  if (config.commit !== undefined && config.commit !== false) {
    throw new ReleaseError('Set `"commit": false` in .changeset/config.json.')
  }
  if (config.changelog === false) {
    throw new ReleaseError("Enable changelog generation in .changeset/config.json.")
  }

  const { packageManager, lockfile } = await detectPackageManager(files, packageJson)
  return {
    ...conventions,
    hasReleaseCheck: typeof packageJson.scripts?.["release:check"] === "string",
    packageManager,
    lockfile,
    baseBranch: typeof config.baseBranch === "string" ? config.baseBranch : "main",
  }
}

/** Returns the command that updates the lockfile after a version change, without installing packages. */
export function getLockfileUpdateCommand(packageManager: PackageManager): [string, string[]] {
  switch (packageManager) {
    case "npm":
      return [
        "npm",
        ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      ]
    case "pnpm":
      return ["pnpm", ["install", "--lockfile-only", "--ignore-scripts"]]
    case "bun":
      return ["bun", ["install", "--lockfile-only", "--ignore-scripts"]]
  }
}

/** Normalizes `privatePackages` of the Changesets config like Changesets does: a boolean applies to both versioning and tagging. */
function getTagPrivatePackages(privatePackages: unknown) {
  if (typeof privatePackages === "boolean") {
    return privatePackages
  }
  return (privatePackages as { tag?: unknown } | undefined)?.tag === true
}

async function detectPackageManager(
  files: RepoFiles,
  packageJson: PackageJson,
): Promise<{ packageManager: PackageManager; lockfile: string | undefined }> {
  const declared =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined
  const present: typeof lockfiles = []
  for (const entry of lockfiles) {
    if (await files.exists(entry[0])) {
      present.push(entry)
    }
  }
  const packageManager = declared ?? present[0]?.[1] ?? "npm"
  if (packageManager !== "npm" && packageManager !== "pnpm" && packageManager !== "bun") {
    throw new ReleaseError(`${packageManager} is not supported; use npm, pnpm, or Bun.`)
  }
  const lockfile = present.find(([, owner]) => owner === packageManager)?.[0]
  return { packageManager, lockfile }
}

/**
 * Reads the release conventions from repository files, at the work tree or at a past commit.
 */
export async function readReleaseConventions(
  readRepoFile: RepoFileReader,
): Promise<ReleaseConventions> {
  const packageJson = parseJson(await readRepoFile("package.json")) as PackageJson | undefined
  const config = parseJson(await readRepoFile(".changeset/config.json")) as
    | ChangesetsConfig
    | undefined
  // pnpm-workspace.yaml also holds settings of single-package projects; only the `packages` key declares workspace packages.
  const pnpmWorkspace = await readRepoFile("pnpm-workspace.yaml")
  return {
    monorepo:
      packageJson?.workspaces !== undefined ||
      (pnpmWorkspace?.split("\n").some(line => line.startsWith("packages:")) ?? false),
    tagPrivatePackages: getTagPrivatePackages(config?.privatePackages),
  }
}

function parseJson(content: string | null): unknown {
  try {
    return content === null ? undefined : JSON.parse(content)
  } catch {
    return undefined
  }
}

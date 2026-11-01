import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { type Context, ReleaseError } from "./context"
import { readJsonFile } from "./json"

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

/** Reads the repository configuration at the project root and fails with an explanation when its layout is not supported. */
export async function readProject(ctx: Context): Promise<Project> {
  const packageJson = await readJsonFile<PackageJson>(join(ctx.cwd, "package.json"))
  if (!packageJson) {
    throw new ReleaseError("changesets-local requires package.json at the repository root.")
  }
  const conventions = await readReleaseConventions(path =>
    readFile(join(ctx.cwd, path), "utf8").catch(() => null),
  )
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

  const config = await readJsonFile<ChangesetsConfig>(join(ctx.cwd, ".changeset", "config.json"))
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

  const { packageManager, lockfile } = detectPackageManager(ctx, packageJson)
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

function detectPackageManager(
  ctx: Context,
  packageJson: PackageJson,
): { packageManager: PackageManager; lockfile: string | undefined } {
  const declared =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]
      : undefined
  const found = lockfiles.find(([file]) => existsSync(join(ctx.cwd, file)))
  const packageManager = declared ?? found?.[1] ?? "npm"
  if (packageManager !== "npm" && packageManager !== "pnpm" && packageManager !== "bun") {
    throw new ReleaseError(`${packageManager} is not supported; use npm, pnpm, or Bun.`)
  }
  const lockfile = lockfiles.find(
    ([file, owner]) => owner === packageManager && existsSync(join(ctx.cwd, file)),
  )?.[0]
  return { packageManager, lockfile }
}

/**
 * Reads the release conventions from repository files, at the work tree or at a past commit.
 *
 * `readRepoFile` returns the content of a file by its path from the repository root, or null when it does not exist.
 */
export async function readReleaseConventions(
  readRepoFile: (path: string) => Promise<string | null>,
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

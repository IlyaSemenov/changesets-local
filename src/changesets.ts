import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Context, logDetail, ReleaseError } from "./context"
import {
  captureCommand,
  describeFailure,
  formatCommand,
  readCommand,
  runCommandWithStatus,
} from "./exec"
import { readJsonFile } from "./json"
import { sortByName } from "./packages"

/** Supported major version of `@changesets/cli`. */
const supportedMajor = 3

/** A pending package release, as planned by `changeset status`. */
export interface PlannedRelease {
  name: string
  /** SemVer bump type. */
  type: "major" | "minor" | "patch"
  newVersion: string
  /** Whether a pending changeset names the package. */
  hasChangeset: boolean
}

/** An entry of `changeset publish-plan`: a package version that `changeset publish` would publish or only tag. */
export interface PublishPlanEntry {
  kind: "publish" | "tag-only"
  name: string
  version: string
  /** npm dist-tag of a publication. */
  tag?: string
}

/** Release plan JSON written by `changeset status --output`. */
interface ReleasePlan {
  changesets: unknown[]
  releases: Array<{
    name: string
    type: string
    newVersion: string
    changesets: string[]
  }>
}

/** Event written to the `CHANGESETS_OUTPUT` file by `changeset publish`. */
interface OutputEvent {
  type?: unknown
  tag?: unknown
}

/** Path of the Changesets CLI installed in a project, relative to the working directory of the command. */
const changesetBin = "node_modules/.bin/changeset"

/** Fails with instructions when the project does not have a supported Changesets CLI installed. */
export async function assertChangesetsInstalled(ctx: Context) {
  const packageJson = await readJsonFile<{ version: string }>(
    join(ctx.cwd, "node_modules", "@changesets", "cli", "package.json"),
  )
  if (!packageJson) {
    throw new ReleaseError(
      `@changesets/cli is not installed. Add @changesets/cli@${supportedMajor} to devDependencies and install dependencies.`,
    )
  }
  const { version } = packageJson
  if (Number(version.split(".")[0]) !== supportedMajor) {
    throw new ReleaseError(
      `@changesets/cli ${version} is installed; changesets-local requires version ${supportedMajor}.`,
    )
  }
}

/** Plans the package releases of the pending changesets, sorted by name; the list is empty without releasable changesets. */
export async function planRelease(ctx: Context, cwd = ctx.cwd): Promise<PlannedRelease[]> {
  const plan = await withTempFile("status.json", async output => {
    await readCommand(ctx, changesetBin, ["status", "--output", output], { cwd })
    return (await readJsonFile<ReleasePlan>(output))!
  })
  return sortByName(
    plan.releases.flatMap(({ name, type, newVersion, changesets }) =>
      isBumpType(type) ? [{ name, type, newVersion, hasChangeset: changesets.length > 0 }] : [],
    ),
  )
}

/** Returns what `changeset publish` would publish and tag from a work tree, as reported by `changeset publish-plan`. */
export async function readPublishPlan(ctx: Context, cwd = ctx.cwd): Promise<PublishPlanEntry[]> {
  const plan = await withTempFile("publish-plan.json", async output => {
    await readCommand(ctx, changesetBin, ["publish-plan", "--output", output], { cwd })
    return (await readJsonFile<{ plan: PublishPlanEntry[][] }>(output))!
  })
  return plan.plan.flat().map(({ kind, name, version, tag }) => ({ kind, name, version, tag }))
}

/**
 * Applies pending changesets: bumps versions and updates changelogs.
 *
 * Prints the output of Changesets, such as configuration warnings, without repeated lines and the lines that do not apply to a release by changesets-local.
 */
export async function applyChangesets(ctx: Context, cwd = ctx.cwd) {
  const args = ["version"]
  logDetail(ctx, `$ ${formatCommand(changesetBin, args)}`)
  const result = await captureCommand(ctx, changesetBin, args, { cwd })
  if (result.code !== 0) {
    throw new ReleaseError(describeFailure(changesetBin, args, result))
  }
  const output = filterVersionOutput(`${result.stdout}\n${result.stderr}`)
  if (output) {
    ctx.log(output)
  }
}

/** Lines of `changeset version` output that changesets-local leaves out: the Changesets banner, and the advice to review and commit the changes, which changesets-local does itself. */
const versionNoise = [/^\S*\s*changeset v\d/, /Review them and commit at your leisure/]

/**
 * Removes the Changesets banner, commit advice, and repeated lines from `changeset version` output, preserving the order of other output.
 *
 * Changesets repeats a warning about a dependency range each time it reads the dependency graph.
 */
export function filterVersionOutput(output: string) {
  const seen = new Set<string>()
  return output
    .split("\n")
    .filter(line => {
      if (versionNoise.some(pattern => pattern.test(line))) {
        return false
      }
      // Blank lines separate paragraphs, so they are not repetitions.
      if (line.trim() === "") {
        return true
      }
      const repeated = seen.has(line)
      seen.add(line)
      return !repeated
    })
    .join("\n")
    .trim()
}

/**
 * Publishes unpublished package versions from the work tree with `changeset publish`, which also tags them.
 *
 * Resolves to the command status and the tags that Changesets reports creating: after successful publications, and for tagged private packages.
 * npm provenance is disabled because it can only be generated in CI.
 */
export async function publishPackages(ctx: Context) {
  return withTempFile("output.ndjson", async output => {
    const result = await runCommandWithStatus(ctx, changesetBin, ["publish"], {
      env: { CHANGESETS_OUTPUT: output, NPM_CONFIG_PROVENANCE: "false" },
    })
    const events = await readOutputEvents(output)
    return {
      succeeded: result.code === 0,
      tags: events.flatMap(event =>
        event.type === "git-tag" && typeof event.tag === "string" ? [event.tag] : [],
      ),
    }
  })
}

async function readOutputEvents(path: string): Promise<OutputEvent[]> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    // Changesets creates the file only when it writes an event.
    return []
  }
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as OutputEvent)
}

function isBumpType(type: string): type is PlannedRelease["type"] {
  return type === "major" || type === "minor" || type === "patch"
}

async function withTempFile<T>(name: string, callback: (path: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "changesets-local-"))
  try {
    return await callback(join(dir, name))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

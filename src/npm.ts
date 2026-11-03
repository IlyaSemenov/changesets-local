import { type Context, logWarning, ReleaseError } from "./context"
import { captureCommand, formatCommand, readCommand, runCommand } from "./exec"

/** Error codes of npm commands that need a login. */
const authErrorCodes = new Set(["E401", "ENEEDAUTH"])

/**
 * Returns the npm user logged in to the registry.
 *
 * When npm is not logged in, runs `npm login` if `login` is set, letting npm ask for credentials in the terminal, and fails otherwise.
 */
export async function getNpmUser(ctx: Context, { login }: { login: boolean }) {
  const user = await readNpmUser(ctx)
  if (user !== undefined) {
    return user
  }
  if (!login) {
    throw new ReleaseError("npm is not logged in. Run `npm login` and try again.")
  }
  logWarning(ctx, "npm is not logged in.")
  // A `scope` in the npm settings would direct the login to the registry of that scope.
  await runCommand(ctx, "npm", ["login", `--registry=${npmjsRegistry}`, "--scope="])
  const loggedInUser = await readNpmUser(ctx)
  if (loggedInUser === undefined) {
    throw new ReleaseError("npm is still not logged in after `npm login`.")
  }
  return loggedInUser
}

/** Returns the npm user logged in to the registry, or `undefined` when npm needs a login; fails on other errors. */
async function readNpmUser(ctx: Context) {
  const result = await captureCommand(ctx, "npm", ["whoami", "--json"])
  const output = parseJson(result.stdout)
  if (result.code === 0 && typeof output === "string") {
    return output
  }
  const error = (output as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error
  if (typeof error?.code === "string" && authErrorCodes.has(error.code)) {
    return undefined
  }
  const reason = typeof error?.summary === "string" ? error.summary : result.stderr.trim()
  throw new ReleaseError(`Could not verify the npm login: ${reason}`)
}

/**
 * Checks whether a package version is published on npm.
 *
 * A just-published version may be reported as missing for several minutes while npm scans it.
 */
export async function isVersionPublished(ctx: Context, name: string, version: string) {
  const result = await captureCommand(ctx, "npm", [
    "view",
    `${name}@${version}`,
    "version",
    "--json",
    "--prefer-online",
  ])
  const output = parseJson(result.stdout)
  if (result.code === 0) {
    return output === version
  }
  const error = (output as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error
  if (error?.code === "E404") {
    return false
  }
  const reason = typeof error?.summary === "string" ? error.summary : result.stderr.trim()
  throw new ReleaseError(`Cannot check ${name}@${version} on npm: ${reason}`)
}

/**
 * Fails unless an npm user can publish a package: as a read-write collaborator of a published package, or as a member of the scope of a new scoped package.
 *
 * npm can still reject a new unscoped package, for example when its name is too similar to an existing one.
 */
export async function assertCanPublish(ctx: Context, user: string, name: string) {
  const collaborators = await readNpmJson(ctx, ["access", "list", "collaborators", name, user])
  if (collaborators.found) {
    if ((collaborators.output as Record<string, unknown>)[user] !== "read-write") {
      throw new ReleaseError(`npm user ${user} cannot publish ${name}.`)
    }
    return
  }
  if (!name.startsWith("@")) {
    return
  }
  const scope = name.split("/")[0]!
  const members = await readNpmJson(ctx, ["org", "ls", scope.slice(1), user])
  if (!members.found) {
    throw new ReleaseError(
      `The npm scope ${scope} of ${name} does not exist. Create the organization on npmjs.com.`,
    )
  }
  if (!(user in (members.output as Record<string, unknown>))) {
    throw new ReleaseError(
      `npm user ${user} is not a member of the ${scope} organization and cannot publish ${name}.`,
    )
  }
}

/** Runs an npm command with JSON output; resolves to `found: false` when the registry reports E404, and fails on other errors. */
async function readNpmJson(ctx: Context, args: string[]) {
  const result = await captureCommand(ctx, "npm", [...args, "--json"])
  const output = parseJson(result.stdout)
  if (result.code === 0 && typeof output === "object" && output !== null) {
    return { found: true, output }
  }
  const error = (output as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error
  if (error?.code === "E404") {
    return { found: false, output: undefined }
  }
  const reason = typeof error?.summary === "string" ? error.summary : result.stderr.trim()
  throw new ReleaseError(`\`${formatCommand("npm", args)}\` failed: ${reason}`)
}

/** URL of the public npm registry, the only supported publication target. */
const npmjsRegistry = "https://registry.npmjs.org"

/** Checks whether a registry URL is the public npm registry. */
export function isNpmjsRegistry(url: string) {
  return url.replace(/\/+$/, "") === npmjsRegistry
}

/**
 * Fails unless the npm settings of the project, and the pnpm settings in a pnpm project, use the public npm registry for the given scopes.
 *
 * npm checks published versions while Changesets publishes with pnpm in pnpm projects, so both must use the same registry.
 * Pass an empty scope list to check only the default registry.
 */
export async function assertNpmjsRegistry(
  ctx: Context,
  tools: Array<"npm" | "pnpm">,
  scopes: string[],
) {
  for (const tool of tools) {
    const registry = await readCommand(ctx, tool, ["config", "get", "registry"])
    if (!isNpmjsRegistry(registry)) {
      throw new ReleaseError(
        `${tool} uses the registry ${registry}; only ${npmjsRegistry} is supported.`,
      )
    }
    for (const scope of scopes) {
      const scopeRegistry = await readCommand(ctx, tool, ["config", "get", `${scope}:registry`])
      if (scopeRegistry !== "undefined" && !isNpmjsRegistry(scopeRegistry)) {
        throw new ReleaseError(
          `${tool} uses the registry ${scopeRegistry} for ${scope}; only ${npmjsRegistry} is supported.`,
        )
      }
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "null")
  } catch {
    return undefined
  }
}

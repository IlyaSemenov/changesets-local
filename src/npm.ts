import { type Context, ReleaseError } from "./context"
import { captureCommand, readCommand } from "./exec"

/** Error codes of npm commands that need a login. */
const authErrorCodes = new Set(["E401", "ENEEDAUTH"])

/** Returns the npm user logged in to the registry, or fails with the reason, suggesting a login when npm needs one. */
export async function getNpmUser(ctx: Context) {
  const result = await captureCommand(ctx, "npm", ["whoami", "--json"])
  const output = parseJson(result.stdout)
  if (result.code === 0 && typeof output === "string") {
    return output
  }
  const error = (output as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error
  if (typeof error?.code === "string" && authErrorCodes.has(error.code)) {
    throw new ReleaseError("npm is not logged in. Run `npm login` and try again.")
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

// Fake npm and pnpm: registry commands work on the fake state, and other commands, such as install, run the real tools.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { fail, type FakeCall, type FakeCommand, findCommand } from "./call"
import { updateFakeState } from "./state"

/** Runs an npm or pnpm command. */
export function runNpm(call: FakeCall) {
  const commands = call.tool === "npm" ? { ...registryCommands, ...npmCommands } : registryCommands
  const command = findCommand(commands, call.args)
  if (command) {
    command(call)
  } else {
    passThrough(call)
  }
}

/** Registry commands that npm and pnpm share. */
const registryCommands: Record<string, FakeCommand> = {
  whoami: showUser,
  view: viewPackage,
  info: viewPackage,
  publish,
}

/** Registry commands that only npm has. */
const npmCommands: Record<string, FakeCommand> = {
  login,
  "access list": listCollaborators,
  "org ls": listOrgMembers,
}

function showUser(call: FakeCall) {
  const { user, loggedOutError, whoamiFailure } = call.state.npm
  if (whoamiFailure) {
    registryError(call, "ECONNRESET", "request to https://registry.npmjs.org/-/whoami failed")
  }
  if (!user) {
    registryError(
      call,
      loggedOutError,
      loggedOutError === "E401"
        ? "Unauthorized - GET https://registry.npmjs.org/-/whoami"
        : "This command requires you to be logged in to https://registry.npmjs.org/",
    )
  }
  console.log(JSON.stringify(user))
}

function login({ state, stateDir }: FakeCall) {
  const { loginUser } = state.npm
  if (!loginUser) {
    fail("npm error code E401\nnpm error Incorrect or missing password.")
  }
  updateFakeState(stateDir, current => {
    current.npm.user = loginUser
  })
}

function viewPackage(call: FakeCall) {
  const { state, tool } = call
  const spec = call.args[1] ?? ""
  const at = spec.lastIndexOf("@")
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined]
  const versions = (state.npm.versions[name] ?? []).filter(
    entry => !state.npm.hidden.includes(`${name}@${entry}`),
  )
  if (version === undefined && versions.length > 0) {
    const distTags = state.npm.distTags[name] ?? { latest: versions.at(-1)! }
    console.log(JSON.stringify({ name, versions, "dist-tags": distTags }))
  } else if (version !== undefined && versions.includes(version)) {
    console.log(JSON.stringify(version))
  } else {
    registryError(
      call,
      tool === "pnpm" ? "ERR_PNPM_PACKAGE_NOT_FOUND" : "E404",
      `Not Found - ${spec}`,
    )
  }
}

function listCollaborators(call: FakeCall) {
  const { state } = call
  const [, , , name = "", user = ""] = call.args
  if (!state.npm.versions[name]?.length) {
    registryError(call, "E404", `Not Found - GET ${name}/collaborators - Package not found`)
  }
  const maintainers = state.npm.maintainers[name] ?? [state.npm.user!]
  console.log(JSON.stringify(maintainers.includes(user) ? { [user]: "read-write" } : {}))
}

function listOrgMembers(call: FakeCall) {
  const { state } = call
  const [, , org = "", user = ""] = call.args
  const scope = `@${org}`
  const members =
    (scope in state.npm.scopes ? state.npm.scopes[scope] : [state.npm.user!]) ??
    registryError(call, "E404", `Not Found - GET -/org/${org}/user - Scope not found`)
  console.log(JSON.stringify(members.includes(user) ? { [user]: "developer" } : {}))
}

function publish(call: FakeCall) {
  const { args, state, stateDir, tool } = call
  const { name, version } = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string
    version: string
  }
  const failure = state.npm.publishFailures[name]
  let conflict = false
  if (failure !== "before-upload") {
    updateFakeState(stateDir, current => {
      const versions = (current.npm.versions[name] ??= [])
      if (versions.includes(version)) {
        conflict = true
        return
      }
      const tag = args[args.indexOf("--tag") + 1]!
      const distTags = (current.npm.distTags[name] ??=
        versions.length > 0 ? { latest: versions.at(-1)! } : {})
      versions.push(version)
      distTags[tag] = version
      current.npm.publishes.push({
        tool,
        name,
        version,
        tag,
        provenance: process.env.NPM_CONFIG_PROVENANCE,
      })
    })
  }
  if (conflict) {
    registryError(
      call,
      "E403",
      `You cannot publish over the previously published versions: ${version}.`,
    )
  }
  if (failure === "before-upload") {
    registryError(call, "E500", "Internal Server Error")
  }
  if (failure === "after-upload") {
    registryError(call, "ECONNRESET", "socket hang up")
  }
}

/** Prints a registry error as JSON output and exits: npm reports `{ error: { code, summary } }`, and pnpm 11+ `{ error: { code, message } }`. */
function registryError({ tool }: FakeCall, code: string, message: string): never {
  const error = tool === "pnpm" ? { code, message } : { code, summary: message, detail: "" }
  process.stdout.write(JSON.stringify({ error }))
  process.exit(1)
}

/** Runs the command with the real tool and exits with its code. */
function passThrough({ tool, args }: FakeCall): never {
  const command = tool === "npm" ? process.env.FAKE_REAL_NPM! : process.env.FAKE_REAL_PNPM!
  // The real tools may need utilities that the restricted test PATH lacks.
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, PATH: process.env.FAKE_REAL_PATH },
  })
  process.exit(result.status ?? 1)
}

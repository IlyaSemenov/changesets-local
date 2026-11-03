// Fake npm, pnpm, and gh for release tests, run as `bun fake-tool.ts <tool> <args...>` through shims on PATH.
// Registry and GitHub commands work on a JSON state file; other npm and pnpm commands, such as install, run the real tools.
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"

/** State of the fake npm registry and GitHub repository. */
export interface FakeState {
  npm: {
    /** Logged-in npm user, or null when logged out. */
    user: string | null
    /** Error code that `npm whoami` reports without a user: ENEEDAUTH without credentials, or E401 for a rejected token. */
    loggedOutError: "ENEEDAUTH" | "E401"
    /** Makes `npm whoami` fail as when the registry is unreachable. */
    whoamiFailure: boolean
    /** User that `npm login` logs in, or null to make the login fail. */
    loginUser: string | null
    /** Published versions by package name. */
    versions: Record<string, string[]>
    /** npm dist-tags by package name; a package without them has `latest` at its last version. */
    distTags: Record<string, Record<string, string>>
    /** Published `name@version` entries that the registry does not show yet, as while npm scans a new version. */
    hidden: string[]
    /** Every publication that reached the registry. */
    publishes: Array<{
      tool: string
      name: string
      version: string
      tag: string
      provenance: string | undefined
    }>
    /** Makes publications of packages fail before the upload or after the version is stored, by package name. */
    publishFailures: Record<string, "before-upload" | "after-upload">
    /** Users who can publish a package, by package name; a published package without an entry has the logged-in user. */
    maintainers: Record<string, string[]>
    /** Members of an npm scope such as `@fixture`, or null for a scope that does not exist; a scope without an entry has the logged-in user. */
    scopes: Record<string, string[] | null>
  }
  gh: {
    /** Whether `gh` is logged in. */
    authenticated: boolean
    repo: string
    releases: Array<{
      tag: string
      title: string
      notes: string
      prerelease: boolean
      draft?: boolean
    }>
    /** Makes release creation fail. */
    createFailure: boolean
    /**
     * CI check runs by commit.
     * A run is omitted for `missingReads` reads, then reports `in_progress` for `pendingReads` reads; with `waiting`, it is always awaiting approval.
     */
    checkRuns: Record<
      string,
      Array<{
        name: string
        conclusion: string
        missingReads?: number
        pendingReads?: number
        waiting?: boolean
      }>
    >
    /** Commit statuses by commit; a status reports `pending` for `pendingReads` reads. */
    statuses: Record<string, Array<{ context: string; state: string; pendingReads?: number }>>
    /** Makes `count` requests for CI checks fail with `error` after the first `after` requests. */
    checkRequestFailures: {
      after: number
      count: number
      error: "network" | "no-access" | "rate-limit"
    } | null
    /** Number of requests for CI checks so far. */
    checkRequests: number
  }
}

/** Returns the initial fake state. */
export function createFakeState(): FakeState {
  return {
    npm: {
      user: "tester",
      loggedOutError: "ENEEDAUTH",
      whoamiFailure: false,
      loginUser: "tester",
      versions: {},
      distTags: {},
      hidden: [],
      publishes: [],
      publishFailures: {},
      maintainers: {},
      scopes: {},
    },
    gh: {
      authenticated: true,
      repo: "owner/fixture",
      releases: [],
      createFailure: false,
      checkRuns: {},
      statuses: {},
      checkRequestFailures: null,
      checkRequests: 0,
    },
  }
}

/** Reads the fake state. */
export function readFakeState(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as FakeState
}

/**
 * Changes the fake state under an exclusive lock.
 *
 * Changesets publishes independent packages in parallel, so concurrent fake publications must not overwrite each other.
 */
export function updateFakeState(stateDir: string, update: (state: FakeState) => void) {
  const lock = join(stateDir, "lock")
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    const state = readFakeState(stateDir)
    update(state)
    // Readers without the lock see either the old or the new file.
    writeFileSync(join(stateDir, "state.next.json"), JSON.stringify(state, null, 2))
    renameSync(join(stateDir, "state.next.json"), join(stateDir, "state.json"))
  } finally {
    rmdirSync(lock)
  }
}

if (import.meta.main) {
  // The tool runs as the interpreter of a script named after the faked command.
  const [script, ...args] = process.argv.slice(2)
  const tool = basename(script!)
  const stateDir = process.env.FAKE_STATE_DIR!
  const state = readFakeState(stateDir)
  appendFileSync(join(stateDir, "calls.ndjson"), `${JSON.stringify([tool, ...args])}\n`)

  const fail = (message: string, code = 1): never => {
    process.stderr.write(`${message}\n`)
    process.exit(code)
  }
  // npm reports errors as `{ error: { code, summary } }`, and pnpm 11+ as `{ error: { code, message } }`.
  const registryError = (code: string, message: string): never => {
    const error = tool === "pnpm" ? { code, message } : { code, summary: message, detail: "" }
    process.stdout.write(JSON.stringify({ error }))
    process.exit(1)
  }
  const passThrough = (command: string): never => {
    // The real tools may need utilities that the restricted test PATH lacks.
    const result = spawnSync(command, args, {
      stdio: "inherit",
      env: { ...process.env, PATH: process.env.FAKE_REAL_PATH },
    })
    process.exit(result.status ?? 1)
  }

  if (tool === "npm" || tool === "pnpm") {
    const [command, spec = ""] = args
    if (command === "whoami") {
      if (state.npm.whoamiFailure) {
        registryError("ECONNRESET", "request to https://registry.npmjs.org/-/whoami failed")
      }
      if (!state.npm.user) {
        registryError(
          state.npm.loggedOutError,
          state.npm.loggedOutError === "E401"
            ? "Unauthorized - GET https://registry.npmjs.org/-/whoami"
            : "This command requires you to be logged in to https://registry.npmjs.org/",
        )
      }
      console.log(JSON.stringify(state.npm.user))
    } else if (tool === "npm" && command === "login") {
      const { loginUser } = state.npm
      if (!loginUser) {
        fail("npm error code E401\nnpm error Incorrect or missing password.")
      }
      updateFakeState(stateDir, current => {
        current.npm.user = loginUser
      })
    } else if (command === "view" || command === "info") {
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
          tool === "pnpm" ? "ERR_PNPM_PACKAGE_NOT_FOUND" : "E404",
          `Not Found - ${spec}`,
        )
      }
    } else if (tool === "npm" && command === "access" && args[1] === "list") {
      const [, , , name = "", user = ""] = args
      if (!state.npm.versions[name]?.length) {
        registryError("E404", `Not Found - GET ${name}/collaborators - Package not found`)
      }
      const maintainers = state.npm.maintainers[name] ?? [state.npm.user!]
      console.log(JSON.stringify(maintainers.includes(user) ? { [user]: "read-write" } : {}))
    } else if (tool === "npm" && command === "org" && args[1] === "ls") {
      const [, , org = "", user = ""] = args
      const scope = `@${org}`
      const members =
        (scope in state.npm.scopes ? state.npm.scopes[scope] : [state.npm.user!]) ??
        registryError("E404", `Not Found - GET -/org/${org}/user - Scope not found`)
      console.log(JSON.stringify(members.includes(user) ? { [user]: "developer" } : {}))
    } else if (command === "publish") {
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
          "E403",
          `You cannot publish over the previously published versions: ${version}.`,
        )
      }
      if (failure === "before-upload") {
        registryError("E500", "Internal Server Error")
      }
      if (failure === "after-upload") {
        registryError("ECONNRESET", "socket hang up")
      }
    } else {
      passThrough(tool === "npm" ? process.env.FAKE_REAL_NPM! : process.env.FAKE_REAL_PNPM!)
    }
  } else if (tool === "gh") {
    if (!state.gh.authenticated) {
      fail("To get started with GitHub CLI, please run:  gh auth login", 4)
    }
    const field = (name: string) =>
      args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ??
      fail(`missing ${name}`)
    const option = (name: string) => args[args.indexOf(name) + 1]
    if (args[0] === "repo" && args[1] === "view") {
      console.log(JSON.stringify({ nameWithOwner: state.gh.repo, viewerPermission: "ADMIN" }))
    } else if (args[0] === "api" && args[1] === "graphql") {
      const tag = field("tag")
      const release = state.gh.releases.find(entry => entry.tag === tag)
      console.log(
        JSON.stringify({
          data: { repository: { release: release ? { isDraft: release.draft === true } : null } },
        }),
      )
    } else if (args[0] === "api" && args[1] === "--paginate") {
      // Prints the items that the jq filter of the real command selects, one JSON object per line.
      const match = /^repos\/(.+)\/commits\/(\w+)\/(check-runs|status)\?/.exec(args[2]!)
      if (!match || match[1] !== state.gh.repo) {
        fail(`unexpected endpoint ${args[2]}`)
      }
      let failure: NonNullable<FakeState["gh"]["checkRequestFailures"]>["error"] | null = null
      updateFakeState(stateDir, current => {
        const failures = current.gh.checkRequestFailures
        const request = current.gh.checkRequests++
        if (failures && request >= failures.after && request < failures.after + failures.count) {
          failure = failures.error
        }
      })
      if (failure === "network") {
        fail(`Get "https://api.github.com/${args[2]}": read: connection reset by peer`)
      } else if (failure === "no-access") {
        fail("gh: Resource not accessible by personal access token (HTTP 403)")
      } else if (failure === "rate-limit") {
        fail("gh: API rate limit exceeded for user ID 1. (HTTP 403)")
      }
      const [, , commit, endpoint] = match!
      const items: unknown[] = []
      updateFakeState(stateDir, current => {
        if (endpoint === "check-runs") {
          for (const run of current.gh.checkRuns[commit!] ?? []) {
            if ((run.missingReads ?? 0) > 0) {
              run.missingReads! -= 1
              continue
            }
            const pending = run.waiting || (run.pendingReads ?? 0) > 0
            items.push({
              name: run.name,
              status: run.waiting ? "waiting" : pending ? "in_progress" : "completed",
              conclusion: pending ? null : run.conclusion,
              html_url: `https://github.com/${current.gh.repo}/runs/${run.name}`,
            })
            run.pendingReads = Math.max(0, (run.pendingReads ?? 0) - 1)
          }
        } else {
          for (const status of current.gh.statuses[commit!] ?? []) {
            const pending = (status.pendingReads ?? 0) > 0
            items.push({
              context: status.context,
              state: pending ? "pending" : status.state,
              target_url: null,
            })
            status.pendingReads = Math.max(0, (status.pendingReads ?? 0) - 1)
          }
        }
      })
      for (const item of items) {
        console.log(JSON.stringify(item))
      }
    } else if (args[0] === "release" && args[1] === "create") {
      const tag = args[2]!
      if (option("--repo") !== state.gh.repo) {
        fail(`unexpected repository ${option("--repo")}`)
      }
      if (state.gh.createFailure) {
        fail("HTTP 502: Bad Gateway")
      }
      const remoteTag = spawnSync(
        "git",
        ["ls-remote", "--tags", process.env.FAKE_REMOTE!, `refs/tags/${tag}`],
        {
          encoding: "utf8",
        },
      )
      if (!remoteTag.stdout.trim()) {
        fail(`tag ${tag} doesn't exist in the remote`)
      }
      const notes = readFileSync(0, "utf8")
      let exists = false
      updateFakeState(stateDir, current => {
        exists = current.gh.releases.some(entry => entry.tag === tag)
        if (!exists) {
          current.gh.releases.push({
            tag,
            title: option("--title")!,
            notes,
            prerelease: args.includes("--prerelease"),
          })
        }
      })
      if (exists) {
        fail("a release with the same tag name already exists")
      }
    } else {
      fail(`unsupported fake gh command: ${args.join(" ")}`)
    }
  } else {
    fail(`unknown fake tool ${tool}`)
  }
}

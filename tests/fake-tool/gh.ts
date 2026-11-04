// Fake gh: login, repository, release, and CI commands work on the fake state, and other commands fail.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { fail, type FakeCall, type FakeCommand, findCommand } from "./call"
import { type FakeState, updateFakeState } from "./state"

/** Runs a gh command. */
export function runGh(call: FakeCall) {
  const authCommand = findCommand(authCommands, call.args)
  if (authCommand) {
    authCommand(call)
    return
  }
  if (!call.state.gh.authenticated) {
    fail("To get started with GitHub CLI, please run:  gh auth login", 4)
  }
  const command =
    findCommand(commands, call.args) ?? fail(`unsupported fake gh command: ${call.args.join(" ")}`)
  command(call)
}

/** Commands that work without a login. */
const authCommands: Record<string, FakeCommand> = {
  "auth token": showToken,
  "auth login": login,
}

/** Commands that need a login. */
const commands: Record<string, FakeCommand> = {
  "repo view": viewRepo,
  "api graphql": queryRelease,
  "api --paginate": listChecks,
  "release create": createRelease,
}

function showToken({ state }: FakeCall) {
  if (!state.gh.authenticated) {
    fail("no oauth token found for github.com")
  }
  console.log("gho_fake")
}

function login({ state, stateDir }: FakeCall) {
  if (state.gh.loginFailure) {
    fail("error authenticating with GitHub: authorization denied")
  }
  updateFakeState(stateDir, current => {
    current.gh.authenticated = true
  })
}

function viewRepo({ state }: FakeCall) {
  if (state.gh.repoViewFailure) {
    fail("error connecting to api.github.com")
  }
  console.log(JSON.stringify({ nameWithOwner: state.gh.repo, viewerPermission: "ADMIN" }))
}

function queryRelease({ args, state }: FakeCall) {
  const tag = args.find(arg => arg.startsWith("tag="))?.slice("tag=".length) ?? fail("missing tag")
  const release = state.gh.releases.find(entry => entry.tag === tag)
  console.log(
    JSON.stringify({
      data: { repository: { release: release ? { isDraft: release.draft === true } : null } },
    }),
  )
}

/** Prints the CI check runs or commit statuses that the jq filter of the real command selects, one JSON object per line. */
function listChecks({ args, state, stateDir }: FakeCall) {
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
  const [, , commit, endpoint] = match
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
}

function createRelease({ args, state, stateDir }: FakeCall) {
  const option = (name: string) => args[args.indexOf(name) + 1]
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
    { encoding: "utf8" },
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
        latest: args.includes("--latest")
          ? true
          : args.includes("--latest=false")
            ? false
            : undefined,
      })
    }
  })
  if (exists) {
    fail("a release with the same tag name already exists")
  }
}

import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import type { FakeState } from "./fake-tool/state"
import { changeset, createFixture, expectReleased, type Fixture, packageName } from "./fixture"

describe("release", () => {
  it("releases a patch version", async () => {
    const fixture = createFixture()
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expectReleased(fixture, "1.0.1")
    expect(fixture.read("CHANGELOG.md")).toMatch(
      /^# fixture-package\n\n## 1\.0\.1\n\n### Patch Changes\n\n- \w+: Fix a bug\.\n$/,
    )
    expect(existsSync(join(fixture.dir, ".changeset", "fix-bug.md"))).toBe(false)
    expect(fixture.git("rev-list", "--count", "HEAD")).toBe("2")
    expect(fixture.state().npm.publishes).toEqual([
      { tool: "npm", name: packageName, version: "1.0.1", tag: "latest", provenance: "false" },
    ])
    expect(fixture.state().gh.releases[0]!.prerelease).toBe(false)
    expect(fixture.calls("npm").filter(([command]) => command === "access")).toHaveLength(1)
  })

  it.each([
    ["minor", "1.1.0", "Minor Changes"],
    ["major", "2.0.0", "Major Changes"],
  ] as const)("releases a %s version", async (type, version, heading) => {
    const fixture = createFixture({
      changesets: {
        feature: changeset(type, "Add a feature."),
        fix: changeset("patch", "Fix a bug."),
      },
    })
    expect((await fixture.run()).error).toBeUndefined()
    expectReleased(fixture, version)
    const notes = fixture.state().gh.releases[0]!.notes
    expect(notes).toContain(`### ${heading}`)
    expect(notes).toContain("### Patch Changes")
    expect(notes).toContain("Add a feature.")
  })

  it("publishes a prerelease to its npm tag and marks the GitHub Release as a prerelease", async () => {
    const fixture = createFixture({ preTag: "beta" })
    fixture.updateState(state => {
      state.npm.versions[packageName] = ["1.0.0"]
    })
    expect((await fixture.run()).error).toBeUndefined()
    expectReleased(fixture, "1.0.1-beta.0")
    expect(fixture.state().npm.publishes[0]!.tag).toBe("beta")
    expect(fixture.state().npm.distTags[packageName]).toEqual({
      latest: "1.0.0",
      beta: "1.0.1-beta.0",
    })
    expect(fixture.state().gh.releases[0]!.prerelease).toBe(true)
  })

  it("leaves the Latest GitHub Release of a single package to GitHub", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.repo = `owner/${packageName}`
    })
    expect((await fixture.run()).error).toBeUndefined()
    expect(fixture.state().gh.releases[0]!.latest).toBeUndefined()
  })

  it("publishes a new package of an npm scope that the user belongs to", async () => {
    const name = "@new/package"
    const fixture = createFixture({
      packageJson: { name },
      changesets: { fix: changeset("patch", "Fix a bug.", [name]) },
    })
    expect((await fixture.run()).error).toBeUndefined()
    expect(fixture.state().npm.versions[name]).toEqual(["1.0.1"])
  })

  it("shows the warnings of Changesets without its advice to commit", async () => {
    const fixture = createFixture({ changesetsConfig: { fixed: [["nonexistent-*"]] } })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Found issues in your config:")
    expect(result.output).not.toContain("commit at your leisure")
  })

  it("leaves no trace when the confirmation is declined", async () => {
    const fixture = createFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({}, { confirm: false })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("restores the working tree after Ctrl+C", async () => {
    const fixture = createFixture()
    const result = await fixture.run({}, { abort: true })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })
})

describe("package managers", () => {
  const releaseCheck = `node -e "require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/check', process.env.npm_lifecycle_event)"`

  it.each([
    ["npm", "package-lock.json", "npm"],
    ["pnpm", "pnpm-lock.yaml", "pnpm"],
    ["bun", "bun.lock", "npm"],
  ] as const)("releases a %s project", async (packageManager, lockfile, publishTool) => {
    const fixture = createFixture({
      packageManager,
      packageJson: { scripts: { "release:check": releaseCheck } },
    })
    expect(existsSync(join(fixture.dir, lockfile))).toBe(true)
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expectReleased(fixture, "1.0.1")
    expect(result.output).toContain(`$ ${packageManager} run release:check`)
    expect(fixture.read("dist/check")).toBe("release:check")
    expect(fixture.state().npm.publishes[0]!.tool).toBe(publishTool)
  })

  it("updates the version in the npm lockfile", async () => {
    const fixture = createFixture({ packageManager: "npm" })
    expect((await fixture.run()).error).toBeUndefined()
    const lockfile = JSON.parse(fixture.read("package-lock.json"))
    expect(lockfile.version).toBe("1.0.1")
    expect(lockfile.packages[""].version).toBe("1.0.1")
    expect(fixture.git("show", "--name-only", "--format=", "HEAD").split("\n")).toContain(
      "package-lock.json",
    )
  })
})

describe("release:check", () => {
  it("restores the working tree when it fails", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "exit 3" } } })
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run()
    expect(result.error?.message).toContain("`bun run release:check` failed with exit code 3")
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(existsSync(join(fixture.dir, "CHANGELOG.md"))).toBe(false)
    expect(fixture.calls("npm").filter(([command]) => command === "publish")).toEqual([])
  })

  it("fails when it changes a released file", async () => {
    const fixture = createFixture({
      packageJson: {
        scripts: {
          "release:check": `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='9.9.9';fs.writeFileSync('package.json',JSON.stringify(p))"`,
        },
      },
    })
    const result = await fixture.run()
    expect(result.error?.message).toContain("release:check changed files:\n  - package.json")
    expect(JSON.parse(fixture.read("package.json")).version).toBe("1.0.0")
  })

  it("fails when it changes files outside the release", async () => {
    const fixture = createFixture({
      packageJson: {
        scripts: { "release:check": `node -e "require('fs').writeFileSync('generated.txt', '')"` },
      },
    })
    const result = await fixture.run()
    expect(result.error?.message).toContain("release:check changed files:\n  - generated.txt")
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })
})

describe("CI checks", () => {
  /** Sets the CI check runs and commit statuses of the fixture HEAD and returns its abbreviated hash. */
  function setChecks(
    fixture: Fixture,
    checks: {
      runs?: FakeState["gh"]["checkRuns"][string]
      statuses?: FakeState["gh"]["statuses"][string]
    },
  ) {
    const head = fixture.git("rev-parse", "HEAD")
    fixture.updateState(state => {
      state.gh.checkRuns[head] = checks.runs ?? []
      state.gh.statuses[head] = checks.statuses ?? []
    })
    return head.slice(0, 7)
  }

  /** Commits and pushes a GitHub Actions workflow. */
  function pushWorkflow(fixture: Fixture) {
    fixture.write(".github/workflows/test.yml", "on: push\n")
    fixture.git("add", "--all")
    fixture.git("commit", "--quiet", "--message", "Add CI")
    fixture.git("push", "--quiet")
  }

  /** Answers yes to the release confirmation and no to the question about failed CI. */
  const declineFailedCi = (question: string) => question !== "Release despite the failed CI?"

  it("waits for running checks of the released commit after release:check", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "true" } } })
    const short = setChecks(fixture, {
      runs: [
        { name: "test", conclusion: "success", pendingReads: 4 },
        { name: "lint", conclusion: "success", pendingReads: 2 },
        { name: "deploy", conclusion: "skipped" },
      ],
      statuses: [{ context: "ci/external", state: "success", pendingReads: 1 }],
    })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expect(result.output).toContain(`CI is running on ${short}: test, lint, ci/external.`)
    expect(result.output).toContain(
      `▸ Waiting for CI on ${short}\nRunning: test, lint\nRunning: test\n✔ CI passed on ${short}`,
    )
    expect(result.output.indexOf("release:check")).toBeLessThan(
      result.output.indexOf("Waiting for CI"),
    )
    expectReleased(fixture, "1.0.1")
  })

  it("asks about a check that appears and fails while the release is prepared", async () => {
    const fixture = createFixture()
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure", missingReads: 1 }] })
    const result = await fixture.run({}, { confirm: declineFailedCi })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.questions).toEqual([
      `Release ${packageName}@1.0.1?`,
      "Release despite the failed CI?",
    ])
    expect(result.output).toContain("▸ Versioning")
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("reads the checks again when the commit has workflows but GitHub has not created its checks yet", async () => {
    const fixture = createFixture()
    pushWorkflow(fixture)
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure", missingReads: 2 }] })
    const result = await fixture.run({}, { confirm: declineFailedCi })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.questions).toEqual([
      `Release ${packageName}@1.0.1?`,
      "Release despite the failed CI?",
    ])
  })

  it("waits for GitHub to create the checks before reading them again", async () => {
    const fixture = createFixture()
    pushWorkflow(fixture)
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure", missingReads: 2 }] })
    const result = await fixture.run({}, { abortOnLog: "Waiting for GitHub to create the checks" })
    expect(result.error?.message).toBe("Interrupted.")
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expect(
      fixture.calls("gh").filter(([, , endpoint]) => endpoint?.includes("/check-runs")),
    ).toHaveLength(2)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("does not wait for checks awaiting approval", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, {
      runs: [
        { name: "test", conclusion: "success" },
        { name: "deploy", conclusion: "success", waiting: true },
      ],
    })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      `⚠ Not waiting for CI checks on ${short} that require approval: deploy.\n✔ CI passed on ${short}`,
    )
    expect(result.output).not.toContain("Waiting for CI")
    expectReleased(fixture, "1.0.1")
  })

  it("warns and releases when the token cannot access CI checks", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 0, count: 100, error: "no-access" }
    })
    const head = fixture.git("rev-parse", "--short=7", "HEAD")
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`⚠ Cannot read CI checks on ${head}; skipping them.`)
    expect(result.output).toContain("Resource not accessible by personal access token")
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expectReleased(fixture, "1.0.1")
  })

  it("retries the first read of the checks after a network failure instead of skipping them", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, { runs: [{ name: "test", conclusion: "failure" }] })
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 0, count: 1, error: "network" }
    })
    const result = await fixture.run({}, { confirm: false })
    expect(result.output).toContain(`Cannot read CI checks on ${short}; retrying.`)
    expect(result.output).not.toContain("skipping them")
    expect(result.questions).toEqual(["Release despite the failed CI?"])
  })

  it("retries reading the checks when a read fails while waiting", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, {
      runs: [{ name: "test", conclusion: "success", pendingReads: 3 }],
    })
    // Each read requests check runs and statuses; the early read and the first read of the wait succeed.
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 4, count: 2, error: "network" }
    })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`Cannot read CI checks on ${short}; retrying.`)
    expect(result.output).toContain(`✔ CI passed on ${short}`)
    expectReleased(fixture, "1.0.1")
  })

  it("fails and restores the working tree when reading the checks keeps failing while waiting", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, {
      runs: [{ name: "test", conclusion: "success", pendingReads: 3 }],
    })
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 4, count: 100, error: "network" }
    })
    const result = await fixture.run()
    expect(result.error?.message).toMatch(
      new RegExp(
        `^Cannot read CI checks on ${short} after 3 attempts\\.\n.*connection reset by peer`,
        "s",
      ),
    )
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("fails when the token loses access to the checks while waiting", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, {
      runs: [{ name: "test", conclusion: "success", pendingReads: 3 }],
    })
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 4, count: 100, error: "no-access" }
    })
    const result = await fixture.run()
    expect(result.error?.message).toMatch(
      new RegExp(`^Cannot read CI checks on ${short}\\.\n.*\\(HTTP 403\\)`, "s"),
    )
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("fails instead of skipping the checks when the API rate limit is exceeded", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, { runs: [{ name: "test", conclusion: "failure" }] })
    fixture.updateState(state => {
      state.gh.checkRequestFailures = { after: 0, count: 100, error: "rate-limit" }
    })
    const result = await fixture.run()
    expect(result.error?.message).toMatch(
      new RegExp(
        `^Cannot read CI checks on ${short} after 3 attempts\\.\n.*API rate limit exceeded`,
        "s",
      ),
    )
    expect(result.output).not.toContain("skipping them")
    expect(result.questions).toEqual([])
  })

  it("asks about failed checks only when there is something to release", async () => {
    const fixture = createFixture({ changesets: {} })
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure" }] })
    const result = await fixture.run()
    expect(result.error?.message).toContain("No pending changesets release any package.")
    expect(result.questions).toEqual([])
  })

  it("asks before versioning when a check has failed", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, {
      runs: [
        { name: "test", conclusion: "cancelled" },
        { name: "lint", conclusion: "success", pendingReads: 1 },
      ],
      statuses: [{ context: "ci/external", state: "error" }],
    })
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({}, { confirm: false })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.questions).toEqual(["Release despite the failed CI?"])
    expect(result.output).toContain(
      `⚠ CI failed on ${short}:\n  - test: https://github.com/owner/fixture/runs/test\n  - ci/external`,
    )
    expect(result.output).not.toContain("▸ Versioning")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("stops waiting when a running check fails and restores the working tree when declined", async () => {
    const fixture = createFixture()
    setChecks(fixture, {
      runs: [
        { name: "test", conclusion: "failure", pendingReads: 2 },
        { name: "slow", conclusion: "success", pendingReads: 1000 },
      ],
    })
    const result = await fixture.run({}, { confirm: declineFailedCi })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.questions).toEqual([
      `Release ${packageName}@1.0.1?`,
      "Release despite the failed CI?",
    ])
    expect(result.output).toContain("▸ Versioning")
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("restores the working tree after Ctrl+C while waiting", async () => {
    const fixture = createFixture()
    setChecks(fixture, { runs: [{ name: "test", conclusion: "success", pendingReads: 1000 }] })
    const result = await fixture.run({}, { abortOnLog: "Waiting for CI" })
    expect(result.error?.message).toBe("Interrupted.")
    expect(result.questions).toEqual([`Release ${packageName}@1.0.1?`])
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("releases despite failed checks when confirmed", async () => {
    const fixture = createFixture()
    setChecks(fixture, { statuses: [{ context: "ci/external", state: "failure" }] })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([
      "Release despite the failed CI?",
      `Release ${packageName}@1.0.1?`,
    ])
    expectReleased(fixture, "1.0.1")
  })

  it("does not wait for the user who has just answered about failed checks", async () => {
    const fixture = createFixture()
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure", missingReads: 1 }] })
    const result = await fixture.run({}, { waitForUser: () => true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([
      `Release ${packageName}@1.0.1?`,
      "Release despite the failed CI?",
    ])
    expect(result.waits).toEqual([])
    expectReleased(fixture, "1.0.1")
  })

  it("waits for the user after long checks when the failed CI was accepted before them", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "true" } } })
    setChecks(fixture, { statuses: [{ context: "ci/external", state: "failure" }] })
    const result = await fixture.run({}, { waitForUser: () => true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([
      "Release despite the failed CI?",
      `Release ${packageName}@1.0.1?`,
    ])
    expect(result.waits).toEqual([
      `Press Enter to publish ${packageName}@1.0.1 as ${fixture.state().npm.user}, Ctrl+C to cancel.`,
    ])
    expectReleased(fixture, "1.0.1")
  })

  it("does not check CI when resuming", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    expect((await fixture.run()).error).toBeDefined()
    fixture.updateState(state => {
      state.gh.createFailure = false
    })
    const calls = fixture.calls("gh").length
    setChecks(fixture, { runs: [{ name: "test", conclusion: "failure" }] })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([`Finish the release "Release ${packageName}@1.0.1"?`])
    expect(
      fixture
        .calls("gh")
        .slice(calls)
        .filter(([, option]) => option === "--paginate"),
    ).toEqual([])
    expectReleased(fixture, "1.0.1")
  })

  it("warns about failed checks in a dry run", async () => {
    const fixture = createFixture()
    const short = setChecks(fixture, { runs: [{ name: "test", conclusion: "timed_out" }] })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([])
    expect(result.output).toContain(
      `⚠ CI failed on ${short}:\n  - test: https://github.com/owner/fixture/runs/test`,
    )
  })
})

describe("checks after the confirmation", () => {
  const releaseCheck = `node -e "require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/check', '')"`

  it("shows the release before running the checks", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "true" } } })
    const short = fixture.git("rev-parse", "--short=7", "HEAD")
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      `Steps:\n  - Run release:check\n  - Check CI on ${short}\n  - Commit "Release ${packageName}@1.0.1"`,
    )
    expect(result.output.indexOf("Steps:")).toBeLessThan(
      result.output.indexOf("$ bun run release:check"),
    )
    expectReleased(fixture, "1.0.1")
  })

  it("does not run the checks when the confirmation is declined", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": releaseCheck } } })
    const result = await fixture.run({}, { confirm: false })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.output).not.toContain("$ bun run release:check")
    expect(existsSync(join(fixture.dir, "dist", "check"))).toBe(false)
  })

  it("waits for the user between long checks and the release commit", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": releaseCheck } } })
    let checked = false
    let commits = ""
    const result = await fixture.run(
      {},
      {
        waitForUser: () => {
          checked = existsSync(join(fixture.dir, "dist", "check"))
          commits = fixture.git("rev-list", "--count", "HEAD")
          return true
        },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.waits).toEqual([
      `Press Enter to publish ${packageName}@1.0.1 as ${fixture.state().npm.user}, Ctrl+C to cancel.`,
    ])
    expect(checked).toBe(true)
    expect(commits).toBe("1")
    expectReleased(fixture, "1.0.1")
  })

  it("does not wait for the user after quick checks", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "true" } } })
    const result = await fixture.run({}, { waitForUser: () => true, presenceTimeout: 60_000 })
    expect(result.error).toBeUndefined()
    expect(result.waits).toEqual([])
    expectReleased(fixture, "1.0.1")
  })

  it("restores the working tree when the user cancels the wait", async () => {
    const fixture = createFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({}, { waitForUser: () => false })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("does not commit when the working tree changes after the confirmation", async () => {
    const fixture = createFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run(
      {},
      {
        waitForUser: () => {
          fixture.write("edited.txt", "")
          return true
        },
      },
    )
    expect(result.error?.message).toContain(
      "The working tree changed after the confirmation:\n  - edited.txt",
    )
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("does not commit when the remote branch moves after the confirmation", async () => {
    const fixture = createFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run(
      {},
      {
        waitForUser: () => {
          const commit = fixture.remoteGit(
            "commit-tree",
            "main^{tree}",
            "-p",
            "main",
            "-m",
            "Other",
          )
          fixture.remoteGit("update-ref", "refs/heads/main", commit)
          return true
        },
      },
    )
    expect(result.error?.message).toBe("main is behind origin/main. Pull the remote changes first.")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })
})

describe("dry run", () => {
  it("shows the release without side effects", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "exit 1" } } })
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([])
    expect(result.output).toContain(`${packageName} 1.0.0 → 1.0.1 (patch)`)
    expect(result.output).toMatch(/Release notes:\n {2}### Patch Changes\n\n {2}- \w+: Fix a bug\./)
    expect(result.output).toContain("CHANGELOG.md")
    expect(result.output).toContain(
      "Dry run: nothing was changed. Not run: bun.lock update, release:check.",
    )

    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.git("tag")).toBe("")
    expect(fixture.git("worktree", "list").split("\n")).toHaveLength(1)
    expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
    expect(fixture.remoteGit("tag")).toBe("")
    expect(fixture.calls("npm").filter(([command]) => command === "publish")).toEqual([])
    expect(fixture.calls("gh").filter(([command]) => command === "release")).toEqual([])
  })

  it("previews the release from HEAD with warnings about the work tree and branch", async () => {
    const fixture = createFixture()
    fixture.git("checkout", "--quiet", "-b", "feature")
    fixture.git("commit", "--quiet", "--allow-empty", "--message", "Local change")
    fixture.write(".changeset/feature.md", changeset("minor", "Add a feature."))
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "⚠ The working tree has uncommitted changes. Commit or discard them first:\n  - .changeset/feature.md",
    )
    expect(result.output).toContain(
      "⚠ Releases are made from main (baseBranch in .changeset/config.json), but feature is checked out.",
    )
    expect(result.output).not.toContain("not pushed")
    // The uncommitted changeset is not part of the preview.
    expect(result.output).toContain(`${packageName} 1.0.0 → 1.0.1 (patch)`)
    expect(result.output).toContain("Push it to origin/main")
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe(
      "?? .changeset/feature.md",
    )
  })

  it("warns about unpushed commits of the base branch in a dry run", async () => {
    const fixture = createFixture()
    fixture.git("commit", "--quiet", "--allow-empty", "--message", "Local change")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "⚠ main has commits that are not pushed to origin/main. Push them first.",
    )
  })

  it("shows a dependency range edited since the tag of the previous version", async () => {
    const fixture = createFixture()
    fixture.git("tag", "v1.0.0")
    const packageJson = JSON.parse(fixture.read("package.json"))
    fixture.write(
      "package.json",
      JSON.stringify({ ...packageJson, dependencies: { dep: "file:./vendor/dep/" } }),
    )
    fixture.git("commit", "--quiet", "--all", "--message", "Change the dependency")
    fixture.git("push", "--quiet")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      `Dependency ranges:\n  ${packageName}: dependencies dep file:./vendor/dep → file:./vendor/dep/\n`,
    )
  })

  it("does not compare a vendored package with the tag of the released package", async () => {
    const fixture = createFixture()
    fixture.git("tag", "v1.0.0")
    fixture.write(
      "vendor/dep/package.json",
      JSON.stringify({ name: "dep", version: "1.0.0", dependencies: { external: "^1.0.0" } }),
    )
    fixture.git("commit", "--quiet", "--all", "--message", "Change the vendored package")
    fixture.git("push", "--quiet")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("is published")
  })

  it("previews the project as committed", async () => {
    const fixture = createFixture()
    const packageJson = JSON.parse(fixture.read("package.json"))
    fixture.write("package.json", JSON.stringify({ ...packageJson, private: true }))
    const config = JSON.parse(fixture.read(".changeset/config.json"))
    fixture.write(".changeset/config.json", JSON.stringify({ ...config, baseBranch: "next" }))
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`${packageName} 1.0.0 → 1.0.1 (patch)`)
    expect(result.output).toContain("Push it to origin/main")
  })
})

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { changeset, createFixture, type Fixture, type FixtureOptions, packageName } from "./fixture"

/** Runs a release that must fail before changing anything, and returns its error message. */
async function runRejected(fixture: Fixture) {
  const head = fixture.git("rev-parse", "HEAD")
  const status = fixture.git("status", "--porcelain", "--untracked-files=all")
  const result = await fixture.run()
  expect(result.error).toBeDefined()
  expect(result.questions).toEqual([])
  expect(fixture.git("rev-parse", "HEAD")).toBe(head)
  expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe(status)
  expect(fixture.git("tag")).toBe("")
  expect(fixture.state().npm.publishes).toEqual([])
  expect(fixture.state().gh.releases).toEqual([])
  return result.error!.message
}

describe("pending changes", () => {
  it("fails without changesets", async () => {
    const fixture = createFixture({ changesets: {} })
    expect(await runRejected(fixture)).toContain("No pending changesets release any package.")
  })

  it("fails with only empty changesets", async () => {
    const fixture = createFixture({ changesets: { empty: "---\n---\n\nInternal change.\n" } })
    expect(await runRejected(fixture)).toContain("No pending changesets release any package.")
  })

  it("fails when the new version is already on npm", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.versions[packageName] = ["1.0.0", "1.0.1"]
    })
    expect(await runRejected(fixture)).toContain(
      `${packageName}@1.0.1 is already published on npm.`,
    )
  })
})

describe("repository state", () => {
  it("fails with uncommitted changes", async () => {
    const fixture = createFixture()
    fixture.write("README.md", "Draft")
    expect(await runRejected(fixture)).toContain(
      "The working tree has uncommitted changes. Commit or discard them first:\n  - README.md",
    )
  })

  it("fails when the branch is behind the remote", async () => {
    const fixture = createFixture()
    const clone = join(mkdtempSync(join(tmpdir(), "changesets-local-test-")), "clone")
    fixture.git("clone", "--quiet", fixture.remote, clone)
    fixture.git("-C", clone, "commit", "--quiet", "--allow-empty", "--message", "Remote change")
    fixture.git("-C", clone, "push", "--quiet")
    expect(await runRejected(fixture)).toContain(
      "main is not up to date with refs/remotes/origin/main.",
    )
  })

  it("fails when the branch has unpushed commits", async () => {
    const fixture = createFixture()
    fixture.git("commit", "--quiet", "--allow-empty", "--message", "Local change")
    expect(await runRejected(fixture)).toContain("main has commits that are not pushed")
  })

  it("fails on a branch other than baseBranch", async () => {
    const fixture = createFixture()
    fixture.git("checkout", "--quiet", "-b", "feature")
    expect(await runRejected(fixture)).toContain(
      "Releases are made from main (baseBranch in .changeset/config.json), but feature is checked out.",
    )
  })

  it("fails without an upstream branch", async () => {
    const fixture = createFixture()
    fixture.git("branch", "--quiet", "--unset-upstream")
    expect(await runRejected(fixture)).toContain("main does not track a remote branch.")
  })
})

describe("tools and authentication", () => {
  /** Name of a package that is not on npm yet. */
  const scopedName = "@new/package"

  function createScopedFixture() {
    return createFixture({
      packageJson: { name: scopedName },
      changesets: { fix: changeset("patch", "Fix a bug.", [scopedName]) },
    })
  }

  it("fails when npm is not logged in", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.user = null
    })
    expect(await runRejected(fixture)).toContain("npm is not logged in. Run `npm login`")
  })

  it("fails when the npm user cannot publish the package", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.versions[packageName] = ["1.0.0"]
      state.npm.maintainers[packageName] = ["owner"]
    })
    expect(await runRejected(fixture)).toContain(`npm user tester cannot publish ${packageName}.`)
  })

  it("fails when the scope of a new package does not exist", async () => {
    const fixture = createScopedFixture()
    fixture.updateState(state => {
      state.npm.scopes["@new"] = null
    })
    expect(await runRejected(fixture)).toContain(
      `The npm scope @new of ${scopedName} does not exist.`,
    )
  })

  it("fails when the npm user is not a member of the scope of a new package", async () => {
    const fixture = createScopedFixture()
    fixture.updateState(state => {
      state.npm.scopes["@new"] = ["owner"]
    })
    expect(await runRejected(fixture)).toContain(
      `npm user tester is not a member of the @new organization and cannot publish ${scopedName}.`,
    )
  })

  it("fails when gh is not logged in", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.authenticated = false
    })
    expect(await runRejected(fixture)).toContain("Log in with `gh auth login`")
  })

  it("fails when pnpm uses another registry", async () => {
    const fixture = createFixture({ packageManager: "pnpm" })
    fixture.env.pnpm_config_registry = "https://npm.example.com/"
    expect(await runRejected(fixture)).toContain("pnpm uses the registry https://npm.example.com/;")
  })

  it.each(["gh", "pnpm"] as const)("fails when %s is not installed", async tool => {
    const fixture = createFixture({ packageManager: "pnpm" })
    fixture.removeTool(tool)
    expect(await runRejected(fixture)).toContain(`\`${tool}\` is not installed or not on PATH.`)
  })
})

describe("project configuration", () => {
  it.each<[string, FixtureOptions["packageJson"], string]>([
    ["a private package", { private: true }, `${packageName} is private.`],
    [
      "npm provenance",
      { publishConfig: { provenance: true } },
      'remove `"provenance": true` from publishConfig',
    ],
    ["Yarn", { packageManager: "yarn@4.0.0" }, "yarn is not supported; use npm, pnpm, or Bun."],
  ])("rejects %s", async (_, packageJson, message) => {
    const fixture = createFixture({ packageJson })
    expect(await runRejected(fixture)).toContain(message)
  })

  it("rejects Changesets configured to commit", async () => {
    const fixture = createFixture()
    fixture.write(".changeset/config.json", JSON.stringify({ commit: true, baseBranch: "main" }))
    fixture.git("commit", "--quiet", "--all", "--message", "Commit config")
    fixture.git("push", "--quiet")
    expect(await runRejected(fixture)).toContain('Set `"commit": false` in .changeset/config.json.')
  })
})

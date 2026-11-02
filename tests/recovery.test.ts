import { describe, expect, it } from "bun:test"

import {
  createFixture,
  createJsonEditCommand,
  expectReleased,
  type Fixture,
  packageName,
} from "./fixture"

/** Counts `npm publish` attempts that reached the fake registry. */
function countPublishAttempts(fixture: Fixture) {
  return fixture.calls("npm").filter(([command]) => command === "publish").length
}

/** Runs a release that fails after the release commit and checks that it points to `--resume`. */
async function runInterrupted(fixture: Fixture, message: string) {
  const result = await fixture.run()
  expect(result.error?.message).toContain(message)
  expect(result.error?.message).toContain("run `changesets-local --resume` to finish it")
  expect(fixture.git("log", "-1", "--format=%s")).toBe("Release fixture-package@1.0.1")
  expect(fixture.git("status", "--porcelain")).toBe("")
}

/** Resumes a release, answering yes, and checks that it completes. */
async function resume(fixture: Fixture) {
  const result = await fixture.run({ resume: true })
  expect(result.error).toBeUndefined()
  expect(result.questions).toEqual(['Finish the release "Release fixture-package@1.0.1"?'])
  expectReleased(fixture, "1.0.1")
  expect(fixture.git("log", "--format=%s").split("\n")).toEqual([
    "Release fixture-package@1.0.1",
    "Initial commit",
  ])
  return result
}

describe("failure after the release commit", () => {
  it("resumes when pushing the release commit fails, before publishing", async () => {
    const fixture = createFixture()
    fixture.rejectPushes("refs/heads/*")
    await runInterrupted(fixture, "`git push origin")
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
    expect(countPublishAttempts(fixture)).toBe(0)

    fixture.rejectPushes(null)
    await resume(fixture)
  })

  it("checks npm permissions again on resume", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.versions[packageName] = ["1.0.0"]
    })
    fixture.rejectPushes("refs/heads/*")
    await runInterrupted(fixture, "`git push origin")
    fixture.rejectPushes(null)
    fixture.updateState(state => {
      state.npm.maintainers[packageName] = ["owner"]
    })
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain(`npm user tester cannot publish ${packageName}.`)
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
  })

  it("resumes when npm publication fails", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe(
      "Release fixture-package@1.0.1",
    )
    expect(fixture.git("tag")).toBe("")

    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    await resume(fixture)
    expect(fixture.state().npm.publishes).toHaveLength(1)
  })

  it("does not publish again when npm reports a failure after storing the version", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "after-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    expect(fixture.state().npm.versions[packageName]).toEqual(["1.0.1"])

    await resume(fixture)
    expect(countPublishAttempts(fixture)).toBe(1)
  })

  it("does not trust a publication that npm does not show", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.versions[packageName] = ["1.0.1"]
      state.npm.hidden = [`${packageName}@1.0.1`]
    })
    await runInterrupted(fixture, "npm does not show fixture-package@1.0.1 after")
    expect(fixture.git("tag")).toBe("")

    fixture.updateState(state => {
      state.npm.hidden = []
    })
    await resume(fixture)
  })

  it("resumes when pushing the tag fails after publishing", async () => {
    const fixture = createFixture()
    fixture.rejectPushes("refs/tags/*")
    await runInterrupted(fixture, "`git push --atomic origin refs/tags/v1.0.1:refs/tags/v1.0.1`")
    expect(fixture.state().npm.versions[packageName]).toEqual(["1.0.1"])
    expect(fixture.git("rev-parse", "v1.0.1^{commit}")).toBe(fixture.git("rev-parse", "HEAD"))

    fixture.rejectPushes(null)
    await resume(fixture)
    expect(countPublishAttempts(fixture)).toBe(1)
  })

  it("resumes when creating the GitHub Release fails", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    await runInterrupted(fixture, "HTTP 502")
    expect(fixture.remoteGit("tag")).toBe("v1.0.1")

    fixture.updateState(state => {
      state.gh.createFailure = false
    })
    const result = await resume(fixture)
    expect(result.output).not.toContain("Pushing")
    expect(countPublishAttempts(fixture)).toBe(1)
  })

  it("creates a missing GitHub Release after later commits", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    await runInterrupted(fixture, "HTTP 502")
    const notes = fixture.read("CHANGELOG.md")
    fixture.write("CHANGELOG.md", "# Rewritten\n")
    fixture.git("commit", "--quiet", "--all", "--message", "Later change")
    fixture.git("push", "--quiet")

    fixture.updateState(state => {
      state.gh.createFailure = false
    })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(fixture.state().gh.releases[0]!.notes).toBe(
      notes.slice(notes.indexOf("### Patch Changes")).trim(),
    )
  })

  it("stops when a Git hook changes the release commit", async () => {
    const fixture = createFixture()
    fixture.installHook(
      "pre-commit",
      `${createJsonEditCommand("package.json", { version: "9.9.9" })}\ngit add package.json`,
    )
    const result = await fixture.run()
    expect(result.error?.message).toContain(
      "The release commit does not match the confirmed release",
    )
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
    expect(countPublishAttempts(fixture)).toBe(0)
  })

  it("runs release:check before publishing on resume", async () => {
    const fixture = createFixture({ packageJson: { scripts: { "release:check": "exit 0" } } })
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    const result = await resume(fixture)
    expect(result.output.indexOf("$ bun run release:check")).toBeLessThan(
      result.output.indexOf("$ node_modules/.bin/changeset publish"),
    )
  })

  it("does not publish on resume when release:check fails", async () => {
    const fixture = createFixture({
      packageJson: {
        scripts: { "release:check": `node -e "process.exit(process.env.FAIL_CHECK ? 1 : 0)"` },
      },
    })
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    fixture.env.FAIL_CHECK = "1"

    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("`bun run release:check` failed")
    expect(countPublishAttempts(fixture)).toBe(1)
    expect(fixture.state().npm.publishes).toEqual([])
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("asks to resume before starting another release", async () => {
    const fixture = createFixture()
    fixture.rejectPushes("refs/tags/*")
    await runInterrupted(fixture, "rejected")
    fixture.write(".changeset/next.md", `---\n"${packageName}": minor\n---\n\nAdd a feature.\n`)
    fixture.git("add", "--all")
    fixture.git("commit", "--quiet", "--message", "Add changeset")

    const result = await fixture.run()
    expect(result.error?.message).toContain(
      'The release "Release fixture-package@1.0.1" is incomplete:',
    )
    expect(result.error?.message).toContain("Run `changesets-local --resume` to finish it.")
    expect(result.questions).toEqual([])
  })
})

describe("abandoned release", () => {
  /** Creates a fixture whose release failed to publish and whose release commit was reverted. */
  async function createRevertedRelease() {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    fixture.git("revert", "--no-edit", "HEAD")
    fixture.git("push", "--quiet")
    return fixture
  }

  it("is not abandoned without confirmation", async () => {
    const fixture = await createRevertedRelease()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({}, { confirm: false })
    expect(result.error?.message).toBe("Release cancelled.")
    expect(result.questions).toEqual(['Abandon the release "Release fixture-package@1.0.1"?'])
    expect(result.output).toContain("npm may hide a version it has just accepted")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
  })

  it("lets a new release start once abandoned", async () => {
    const fixture = await createRevertedRelease()
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([
      'Abandon the release "Release fixture-package@1.0.1"?',
      `Release ${packageName}@1.0.1?`,
    ])
    expectReleased(fixture, "1.0.1")
  })

  it("does not offer abandonment once anything is published", async () => {
    const fixture = createFixture()
    fixture.rejectPushes("refs/tags/*")
    await runInterrupted(fixture, "rejected")
    fixture.rejectPushes(null)
    fixture.git("revert", "--no-edit", "HEAD")
    fixture.git("push", "--quiet")
    const result = await fixture.run()
    expect(result.error?.message).toContain(
      'The release "Release fixture-package@1.0.1" is incomplete:',
    )
    expect(result.questions).toEqual([])
  })
})

describe("resume", () => {
  it("reports a complete release without changes", async () => {
    const fixture = createFixture()
    expect((await fixture.run()).error).toBeUndefined()
    const calls = fixture.calls("gh").length

    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('"Release fixture-package@1.0.1" is completely released.')
    expect(result.questions).toEqual([])
    expect(countPublishAttempts(fixture)).toBe(1)
    expect(fixture.calls("gh").filter(([command]) => command === "release")).toHaveLength(1)
    expect(fixture.calls("gh").length).toBeGreaterThan(calls)
  })

  it("fails without a release commit", async () => {
    const fixture = createFixture()
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("Nothing to resume: no release commit found.")
  })

  it("shows the remaining steps in a dry run", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    await runInterrupted(fixture, "HTTP 502")

    const result = await fixture.run({ resume: true, dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("✔ Tag v1.0.1 pushed")
    expect(result.output).toContain("✘ GitHub Release v1.0.1 created")
    expect(result.output).toContain("Dry run: nothing was changed.")
    expect(result.questions).toEqual([])
    expect(fixture.state().gh.releases).toEqual([])
  })

  it("stops at a draft GitHub Release", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    await runInterrupted(fixture, "HTTP 502")
    fixture.updateState(state => {
      state.gh.createFailure = false
      state.gh.releases.push({
        tag: "v1.0.1",
        title: "v1.0.1",
        notes: "",
        prerelease: false,
        draft: true,
      })
    })
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("The GitHub Release v1.0.1 is a draft.")
    expect(result.questions).toEqual([])
  })

  it("does not consider a release complete when its tag points to another commit", async () => {
    const fixture = createFixture()
    expect((await fixture.run()).error).toBeUndefined()
    fixture.remoteGit("tag", "--force", "v1.0.1", "HEAD~1")

    for (const options of [{ resume: true }, {}]) {
      const result = await fixture.run(options)
      expect(result.error?.message).toContain("Remote tag v1.0.1 points to")
    }
  })

  it("stops when the remote tag points to another commit", async () => {
    const fixture = createFixture()
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    await runInterrupted(fixture, "`changeset publish` failed.")
    fixture.git("tag", "v1.0.1", "HEAD~1")
    fixture.git("push", "--quiet", "origin", "v1.0.1")
    fixture.git("tag", "--delete", "v1.0.1")

    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("Remote tag v1.0.1 points to")
    expect(result.questions).toEqual([])
    expect(countPublishAttempts(fixture)).toBe(1)
  })
})

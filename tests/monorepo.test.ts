import { describe, expect, it } from "bun:test"

import {
  changeset,
  createFixture,
  createJsonEditCommand,
  expectPackageReleased,
  type Fixture,
  privatePackage,
} from "./fixture"

const subject = "Release @fixture/beta@1.0.1, alpha@1.1.0"

/** Asserts that the default monorepo release is complete. */
function expectMonorepoReleased(fixture: Fixture) {
  expect(fixture.git("log", "-1", "--format=%s")).toBe(subject)
  expect(fixture.git("status", "--porcelain")).toBe("")
  expect(fixture.remoteGit("rev-parse", "main")).toBe(fixture.git("rev-parse", "HEAD"))
  expectPackageReleased(fixture, "packages/alpha", "1.1.0")
  expectPackageReleased(fixture, "packages/beta", "1.0.1")
}

describe("monorepo release", () => {
  it.each([
    ["bun", "npm"],
    ["pnpm", "pnpm"],
    ["npm", "npm"],
  ] as const)(
    "releases changed packages of a %s workspace",
    async (packageManager, publishTool) => {
      const fixture = createFixture({ monorepo: true, packageManager })
      const result = await fixture.run()
      expect(result.error).toBeUndefined()
      expect(result.questions).toEqual(["Release @fixture/beta@1.0.1, alpha@1.1.0?"])
      expect(result.output).toContain(
        "Publish to npm as tester: @fixture/beta@1.0.1 (latest), alpha@1.1.0 (latest)",
      )
      expectMonorepoReleased(fixture)
      expect(
        fixture
          .state()
          .npm.publishes.map(entry => `${entry.tool} ${entry.name}@${entry.version}`)
          .toSorted(),
      ).toEqual([`${publishTool} @fixture/beta@1.0.1`, `${publishTool} alpha@1.1.0`])
      expect(
        fixture
          .state()
          .gh.releases.map(entry => entry.tag)
          .toSorted(),
      ).toEqual(["@fixture/beta@1.0.1", "alpha@1.1.0"])
      expect(fixture.remoteGit("tag").split("\n").toSorted()).toEqual([
        "@fixture/beta@1.0.1",
        "alpha@1.1.0",
      ])
    },
  )

  it("tags private packages when Changesets tags them", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: true },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(fixture.git("log", "-1", "--format=%s")).toBe(
      "Release @fixture/example@1.0.1, alpha@1.0.1",
    )
    expect(fixture.state().npm.publishes.map(entry => entry.name)).toEqual(["alpha"])
    expect(fixture.remoteGit("tag").split("\n").toSorted()).toEqual([
      "@fixture/example@1.0.1",
      "alpha@1.0.1",
    ])
    expect(
      fixture
        .state()
        .gh.releases.map(entry => entry.tag)
        .toSorted(),
    ).toEqual(["@fixture/example@1.0.1", "alpha@1.0.1"])
  })

  it("versions private packages without tagging them", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: { version: true, tag: false } },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    expect((await fixture.run()).error).toBeUndefined()
    expect(fixture.remoteGit("tag")).toBe("alpha@1.0.1")
    expect(fixture.state().gh.releases.map(entry => entry.tag)).toEqual(["alpha@1.0.1"])
  })

  it("does not check versioned private packages on npm", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: { version: true, tag: false } },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    fixture.updateState(state => {
      // Another package with the same name is on npm.
      state.npm.versions[privatePackage.name] = ["1.0.1"]
    })
    // The scope of the private package, which no released public package shares, uses a private registry.
    fixture.env["npm_config_@fixture:registry"] = "https://npm.example.com/"
    expect((await fixture.run()).error).toBeUndefined()
    expect(fixture.remoteGit("tag")).toBe("alpha@1.0.1")
    const resumed = await fixture.run({ resume: true })
    expect(resumed.error).toBeUndefined()
    expect(resumed.output).toContain("is completely released.")
  })

  it("stops before publishing an unpublished package outside the release", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.updateState(state => {
      state.npm.versions["@fixture/beta"] = []
    })
    fixture.git("rm", "--quiet", ".changeset/fix.md")
    fixture.git("commit", "--quiet", "--message", "Drop the beta changeset")
    fixture.git("push", "--quiet")
    const head = fixture.git("rev-parse", "HEAD")

    const result = await fixture.run()
    expect(result.error?.message).toContain(
      "`changeset publish` would not publish exactly this release:",
    )
    expect(result.error?.message).toContain("unexpected: publish @fixture/beta@1.0.0")
    expect(result.questions).toEqual([])
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("rejects workspace dependencies that npm publishes unchanged", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.write(
      "packages/beta/package.json",
      JSON.stringify({
        name: "@fixture/beta",
        version: "1.0.0",
        dependencies: { alpha: "workspace:^" },
      }),
    )
    fixture.git("commit", "--quiet", "--all", "--message", "Depend on alpha")
    fixture.git("push", "--quiet")
    const result = await fixture.run()
    expect(result.error?.message).toContain(
      "packages/beta/package.json: replace alpha@workspace:^ in dependencies with a version range",
    )
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  it("shows the release in a dry run", async () => {
    const fixture = createFixture({ monorepo: true })
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(subject)
    expect(result.output).toContain("alpha 1.0.0 → 1.1.0 (minor)")
    expect(result.output).toMatch(
      /alpha@1\.1\.0\n {4}### Minor Changes\n\n {4}- \w+: Add a feature\./,
    )
    expect(result.output).toContain(
      "Create GitHub Releases in owner/fixture: @fixture/beta@1.0.1, alpha@1.1.0",
    )
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("previews the committed Changesets configuration in a dry run", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: true },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    const config = JSON.parse(fixture.read(".changeset/config.json"))
    fixture.write(
      ".changeset/config.json",
      JSON.stringify({ ...config, privatePackages: { version: true, tag: false } }),
    )
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Create and push tags @fixture/example@1.0.1, alpha@1.0.1")
  })
})

describe("monorepo release with dependent packages", () => {
  /** Creates a pnpm monorepo where beta depends on alpha through the workspace and only alpha has a changeset. */
  function createDependentFixture() {
    return createFixture({
      monorepo: true,
      packageManager: "pnpm",
      packages: { "packages/beta": { dependencies: { alpha: "workspace:^1.0.0" } } },
      changesets: { breaking: changeset("major", "Change the API.", ["alpha"]) },
    })
  }

  it("releases a dependent package bumped by Changesets", async () => {
    const fixture = createDependentFixture()
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(fixture.git("log", "-1", "--format=%s")).toBe("Release @fixture/beta@1.0.1, alpha@2.0.0")
    expect(JSON.parse(fixture.read("packages/beta/package.json")).dependencies).toEqual({
      alpha: "workspace:^2.0.0",
    })
    expect(
      fixture.state().npm.publishes.map(entry => `${entry.tool} ${entry.name}@${entry.version}`),
    ).toEqual(["pnpm alpha@2.0.0", "pnpm @fixture/beta@1.0.1"])
    expectPackageReleased(fixture, "packages/alpha", "2.0.0")
    expectPackageReleased(fixture, "packages/beta", "1.0.1")
  })

  it("resumes after the dependent package fails to publish", async () => {
    const fixture = createDependentFixture()
    fixture.updateState(state => {
      state.npm.publishFailures["@fixture/beta"] = "before-upload"
    })
    expect((await fixture.run()).error?.message).toContain("`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    expect((await fixture.run({ resume: true })).error).toBeUndefined()
    expectPackageReleased(fixture, "packages/alpha", "2.0.0")
    expectPackageReleased(fixture, "packages/beta", "1.0.1")
  })
})

describe("monorepo recovery", () => {
  it("resumes after one of the packages fails to publish", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.updateState(state => {
      state.npm.publishFailures["@fixture/beta"] = "before-upload"
    })
    const failed = await fixture.run()
    expect(failed.error?.message).toContain("`changeset publish` failed.")
    expect(fixture.state().npm.publishes.map(entry => entry.name)).toEqual(["alpha"])

    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("✔ alpha@1.1.0 published to npm")
    expect(result.output).toContain("✘ @fixture/beta@1.0.1 published to npm")
    expectMonorepoReleased(fixture)
    expect(fixture.state().npm.publishes.map(entry => entry.name)).toEqual([
      "alpha",
      "@fixture/beta",
    ])
  })

  it("publishes packages in parallel and does not trust a publication that npm does not show", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.updateState(state => {
      state.npm.versions.alpha = ["1.0.0", "1.1.0"]
      state.npm.hidden = ["alpha@1.1.0"]
    })
    const failed = await fixture.run()
    expect(failed.error?.message).toContain(
      "npm does not show alpha@1.1.0 after `changeset publish`",
    )
    expect(fixture.state().npm.versions["@fixture/beta"]).toEqual(["1.0.0", "1.0.1"])

    fixture.updateState(state => {
      state.npm.hidden = []
    })
    expect((await fixture.run({ resume: true })).error).toBeUndefined()
    expectMonorepoReleased(fixture)
  })

  it("stops when a Git hook makes a released package private", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.installHook(
      "pre-commit",
      `${createJsonEditCommand("packages/alpha/package.json", { private: true })}\ngit add packages/alpha/package.json`,
    )
    const result = await fixture.run()
    expect(result.error?.message).toContain(
      "The release commit does not match the confirmed release",
    )
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("stops before pushing when a Git hook makes another package public", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.installHook(
      "pre-commit",
      `${createJsonEditCommand(`${privatePackage.dir}/package.json`, { private: false })}\ngit add ${privatePackage.dir}/package.json`,
    )
    const result = await fixture.run()
    expect(result.error?.message).toContain(`unexpected: publish ${privatePackage.name}@1.0.0`)
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("stops when a Git hook changes the tagging configuration in the release commit", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: { version: true, tag: false } },
      changesets: { example: changeset("patch", "Fix the example.", [privatePackage.name]) },
    })
    fixture.installHook(
      "pre-commit",
      `${createJsonEditCommand(".changeset/config.json", { privatePackages: { version: true, tag: true } })}\ngit add .changeset/config.json`,
    )
    const result = await fixture.run()
    expect(result.error?.message).toContain(
      "The release commit does not match the confirmed release",
    )
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe("Initial commit")
  })

  it("stops before publishing when a pre-push Git hook changes the work tree", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.installHook(
      "pre-push",
      createJsonEditCommand(`${privatePackage.dir}/package.json`, { private: false }),
    )
    const result = await fixture.run()
    expect(result.error?.message).toContain("The work tree changed after the release commit")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("stops before publishing when a pre-push Git hook moves HEAD", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.installHook("pre-push", "git commit --quiet --allow-empty --message Unexpected")
    const result = await fixture.run()
    expect(result.error?.message).toContain("HEAD moved past the release commit")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("stops on resume when another package would be published", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesets: { feature: changeset("minor", "Add a feature.", ["alpha"]) },
    })
    fixture.updateState(state => {
      state.npm.publishFailures.alpha = "before-upload"
    })
    expect((await fixture.run()).error?.message).toContain("`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
      state.npm.versions["@fixture/beta"] = []
    })
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("unexpected: publish @fixture/beta@1.0.0")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("does not trust a scoped registry other than npm on resume", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    expect((await fixture.run()).error?.message).toContain("HTTP 502")
    fixture.env["npm_config_@fixture:registry"] = "https://npm.example.com/"
    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain(
      "npm uses the registry https://npm.example.com/ for @fixture;",
    )
  })

  it("finishes a release with the tagging configuration of its release commit", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: true },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    expect((await fixture.run()).error?.message).toContain("HTTP 502")
    const config = JSON.parse(fixture.read(".changeset/config.json"))
    fixture.write(".changeset/config.json", JSON.stringify({ ...config, privatePackages: false }))
    fixture.git("commit", "--quiet", "--all", "--message", "Stop tagging private packages")
    fixture.git("push", "--quiet")
    fixture.updateState(state => {
      state.gh.createFailure = false
    })

    expect((await fixture.run({ resume: true })).error).toBeUndefined()
    expect(
      fixture
        .state()
        .gh.releases.map(entry => entry.tag)
        .toSorted(),
    ).toEqual(["@fixture/example@1.0.1", "alpha@1.0.1"])
  })
})

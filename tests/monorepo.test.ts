import { describe, expect, it } from "bun:test"

import {
  changeset,
  createFixture,
  createJsonEditCommand,
  expectPackageReleased,
  type Fixture,
  type FixtureOptions,
  privatePackage,
} from "./fixture"

const subject = "Release alpha@1.1.0, @fixture/beta@1.0.1"

/** Asserts that the default monorepo release is complete. */
function expectMonorepoReleased(fixture: Fixture) {
  expect(fixture.git("log", "-1", "--format=%s")).toBe(subject)
  expect(fixture.git("status", "--porcelain")).toBe("")
  expect(fixture.remoteGit("rev-parse", "main")).toBe(fixture.git("rev-parse", "HEAD"))
  expectPackageReleased(fixture, "packages/alpha", "1.1.0")
  expectPackageReleased(fixture, "packages/beta", "1.0.1")
}

/** Changes top-level fields of a package manifest in a pushed commit; undefined removes a field. */
function commitManifest(fixture: Fixture, dir: string, fields: Record<string, unknown>) {
  const path = `${dir}/package.json`
  fixture.write(path, JSON.stringify({ ...JSON.parse(fixture.read(path)), ...fields }))
  fixture.git("commit", "--quiet", "--all", "--message", "Change the manifest")
  fixture.git("push", "--quiet")
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
      expect(result.questions).toEqual(["Release alpha@1.1.0, @fixture/beta@1.0.1?"])
      expect(result.output).toContain(
        "Publish to npm as tester: alpha@1.1.0 (latest), @fixture/beta@1.0.1 (latest)",
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
      "Release alpha@1.0.1, @fixture/example@1.0.1",
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
      /alpha@1\.1\.0\n {4}### Minor Changes\n\n {4}- \w+: Add a feature\.\n\n {2}@fixture\/beta@1\.0\.1\n/,
    )
    expect(result.output).toMatch(/Fix a bug\.\n\nChanges:/)
    expect(result.output).toContain(
      "Create GitHub Releases in owner/fixture: alpha@1.1.0, @fixture/beta@1.0.1",
    )
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe("")
    expect(fixture.state().npm.publishes).toEqual([])
  })

  it("marks a package without a changeset and without dependencies in the release", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { fixed: [["alpha", "@fixture/beta"]] },
      changesets: { fix: changeset("patch", "Fix alpha.", ["alpha"]) },
    })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("  alpha 1.0.0 → 1.0.1 (patch)\n")
    expect(result.output).toContain("  @fixture/beta 1.0.0 → 1.0.1 (patch, no changeset)\n")
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
    expect(result.output).toContain("Create and push tags alpha@1.0.1, @fixture/example@1.0.1")
  })

  it.each([
    ["fixed", "(patch, no changeset)", ["alpha"]],
    ["linked", "(patch)", ["alpha", "@fixture/beta"]],
  ] as const)(
    "shows a package's previous version when it is lower than the others in a %s group",
    async (group, bump, names) => {
      const fixture = createFixture({
        monorepo: true,
        packages: { "packages/beta": { version: "0.9.0" } },
        changesetsConfig: { [group]: [["alpha", "@fixture/beta"]] },
        changesets: { fix: changeset("patch", "Fix the group.", [...names]) },
      })
      const result = await fixture.run({ dryRun: true })
      expect(result.error).toBeUndefined()
      expect(result.output).toContain(`  @fixture/beta 0.9.0 → 1.0.1 ${bump}\n`)
    },
  )
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
    expect(fixture.git("log", "-1", "--format=%s")).toBe("Release alpha@2.0.0, @fixture/beta@1.0.1")
    expect(JSON.parse(fixture.read("packages/beta/package.json")).dependencies).toEqual({
      alpha: "workspace:^2.0.0",
    })
    expect(
      fixture.state().npm.publishes.map(entry => `${entry.tool} ${entry.name}@${entry.version}`),
    ).toEqual(["pnpm alpha@2.0.0", "pnpm @fixture/beta@1.0.1"])
    expectPackageReleased(fixture, "packages/alpha", "2.0.0")
    expectPackageReleased(fixture, "packages/beta", "1.0.1")
  })

  it("prints a warning about a dependency range once", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesets: { fix: changeset("patch", "Fix both.", ["alpha", "@fixture/beta"]) },
    })
    commitManifest(fixture, "packages/beta", { dependencies: { alpha: "^1.0.1" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(
      result.output.split("must depend on the current version of alpha: 1.0.0 vs ^1.0.1").length,
    ).toBe(2)
  })

  it.each([{ dryRun: false }, { dryRun: true }])(
    "explains the release of a package without a changeset with %o",
    async options => {
      const fixture = createDependentFixture()
      const result = await fixture.run(options)
      expect(result.error).toBeUndefined()
      expect(result.output).toContain("  alpha 1.0.0 → 2.0.0 (major)\n")
      expect(result.output).toContain(
        "  @fixture/beta 1.0.0 → 1.0.1 (patch, no changeset: depends on alpha@2.0.0)\n",
      )
    },
  )

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

describe("dependency ranges", () => {
  it("lists the ranges that Changesets changes", async () => {
    const fixture = createFixture({
      monorepo: true,
      packageManager: "pnpm",
      packages: { "packages/beta": { peerDependencies: { alpha: "workspace:^1.0.0" } } },
      changesets: { breaking: changeset("major", "Change the API.", ["alpha"]) },
    })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "\nDependency ranges:\n  @fixture/beta: peerDependencies alpha workspace:^1.0.0 → workspace:^2.0.0\n\nRelease notes:\n",
    )
  })

  it("lists the ranges that Changesets changes in a dry run", async () => {
    const fixture = createFixture({
      monorepo: true,
      packages: { "packages/beta": { dependencies: { alpha: ">=1.0.0 <2" } } },
      changesets: { all: changeset("minor", "Add a feature.", ["alpha", "@fixture/beta"]) },
    })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "  @fixture/beta: dependencies alpha >=1.0.0 <2 → >=1.1.0 <2.0.0-0\n",
    )
  })

  describe("with an external dependency edited by hand", () => {
    /** Creates a monorepo where beta depends on an external package at the tag of its version, if any, and at another range at HEAD. */
    function createEditedFixture({ tagged }: { tagged: boolean }) {
      const fixture = createFixture({ monorepo: true })
      commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.0.0" } })
      if (tagged) {
        fixture.git("tag", "@fixture/beta@1.0.0")
      }
      commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.2.0" } })
      return fixture
    }

    it("compares with the tag of the previous version", async () => {
      const result = await createEditedFixture({ tagged: true }).run({ dryRun: true })
      expect(result.error).toBeUndefined()
      expect(result.output).toContain("  @fixture/beta: dependencies external ^1.0.0 → ^1.2.0\n")
    })

    it("compares with HEAD without the tag", async () => {
      const result = await createEditedFixture({ tagged: false }).run({ dryRun: true })
      expect(result.error).toBeUndefined()
      expect(result.output).not.toContain("Dependency ranges:")
    })
  })

  it("shows a dependency moved to another section as a removal and an addition", async () => {
    const fixture = createFixture({ monorepo: true })
    commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.0.0" } })
    fixture.git("tag", "@fixture/beta@1.0.0")
    commitManifest(fixture, "packages/beta", {
      dependencies: undefined,
      peerDependencies: { external: ">=1.0.0 <3" },
    })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "  @fixture/beta: dependencies external ^1.0.0 → removed\n  @fixture/beta: peerDependencies external added >=1.0.0 <3\n",
    )
  })

  it("finds the tag by the version of the package in a fixed group", async () => {
    const fixture = createFixture({
      monorepo: true,
      packages: { "packages/beta": { version: "0.9.0" } },
      changesetsConfig: { fixed: [["alpha", "@fixture/beta"]] },
      changesets: { fix: changeset("patch", "Fix alpha.", ["alpha"]) },
    })
    commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.0.0" } })
    fixture.git("tag", "@fixture/beta@0.9.0")
    commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.2.0" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("  @fixture/beta: dependencies external ^1.0.0 → ^1.2.0\n")
  })

  it("leaves out development dependencies", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.git("tag", "@fixture/beta@1.0.0")
    commitManifest(fixture, "packages/beta", { devDependencies: { external: "^1.0.0" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("Dependency ranges:")
  })

  it("leaves out private packages", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesetsConfig: { privatePackages: true },
      changesets: { all: changeset("patch", "Fix everything.", ["alpha", privatePackage.name]) },
    })
    fixture.git("tag", `${privatePackage.name}@1.0.0`)
    commitManifest(fixture, privatePackage.dir, { dependencies: { external: "^1.0.0" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("Dependency ranges:")
  })
})

describe("dependency ranges of packages outside the release", () => {
  const warning =
    "⚠ @fixture/beta@1.0.0 is published with alpha ^1.0.0, but package.json now has >=1.0.0 <3.\n  Add a changeset for @fixture/beta to publish this change.\n"

  /** Creates a monorepo that releases only alpha, where beta has another range of alpha at HEAD than at the tag of its version, if any. */
  function createEditedFixture({ tagged = true }: { tagged?: boolean } = {}) {
    const fixture = createFixture({
      monorepo: true,
      packages: { "packages/beta": { dependencies: { alpha: "^1.0.0" } } },
      changesets: { feature: changeset("minor", "Add a feature.", ["alpha"]) },
    })
    if (tagged) {
      fixture.git("tag", "@fixture/beta@1.0.0")
    }
    commitManifest(fixture, "packages/beta", { dependencies: { alpha: ">=1.0.0 <3" } })
    return fixture
  }

  it("warns and still releases", async () => {
    const fixture = createEditedFixture()
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(warning)
    expect(fixture.git("log", "-1", "--format=%s")).toBe("Release alpha@1.1.0")
    expectPackageReleased(fixture, "packages/alpha", "1.1.0")
  })

  it("warns in a dry run", async () => {
    const result = await createEditedFixture().run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(warning)
  })

  it("skips a package without the tag of its version", async () => {
    const result = await createEditedFixture({ tagged: false }).run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("is published with")
  })

  it("does not warn about a package without differences", async () => {
    const fixture = createFixture({
      monorepo: true,
      packages: { "packages/beta": { dependencies: { alpha: "^1.0.0" } } },
      changesets: { feature: changeset("minor", "Add a feature.", ["alpha"]) },
    })
    fixture.git("tag", "@fixture/beta@1.0.0")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("is published with")
  })

  it("skips private packages", async () => {
    const fixture = createFixture({
      monorepo: true,
      changesets: { feature: changeset("minor", "Add a feature.", ["alpha"]) },
    })
    fixture.git("tag", `${privatePackage.name}@1.0.0`)
    commitManifest(fixture, privatePackage.dir, { dependencies: { external: "^1.0.0" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("is published")
  })

  it("does not warn about a package in the release", async () => {
    const fixture = createFixture({
      monorepo: true,
      packages: { "packages/beta": { dependencies: { external: "^1.0.0" } } },
    })
    fixture.git("tag", "@fixture/beta@1.0.0")
    commitManifest(fixture, "packages/beta", { dependencies: { external: "^1.2.0" } })
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("  @fixture/beta: dependencies external ^1.0.0 → ^1.2.0\n")
    expect(result.output).not.toContain("is published with")
  })

  it("does not warn when resuming a release", async () => {
    const fixture = createEditedFixture()
    fixture.updateState(state => {
      state.npm.publishFailures.alpha = "before-upload"
    })
    expect((await fixture.run()).error?.message).toContain("`changeset publish` failed.")
    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.output).not.toContain("is published with")
  })
})

describe("Latest GitHub Release", () => {
  const onlyBeta = { fix: changeset("patch", "Fix a bug.", ["@fixture/beta"]) }

  /** Creates a monorepo in the GitHub repository named after `alpha`. */
  function createMainPackageFixture(options: FixtureOptions = {}) {
    const fixture = createFixture({ monorepo: true, ...options })
    fixture.updateState(state => {
      state.gh.repo = "owner/alpha"
    })
    return fixture
  }

  /** Pushes the tag of the current version of `alpha`, which marks it as released. */
  function pushMainPackageTag(fixture: Fixture) {
    fixture.git("tag", "alpha@1.0.0")
    fixture.git("push", "--quiet", "origin", "alpha@1.0.0")
  }

  /** Returns the `--latest` option of each created GitHub Release by tag, or null without the option. */
  function getLatestMarks(fixture: Fixture) {
    return Object.fromEntries(
      fixture.state().gh.releases.map(entry => [entry.tag, entry.latest ?? null]),
    )
  }

  it("gives the mark to the main package and keeps it from the others", async () => {
    const fixture = createMainPackageFixture()
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "Create GitHub Releases in owner/alpha: alpha@1.1.0 (latest), @fixture/beta@1.0.1\n",
    )
    expect(getLatestMarks(fixture)).toEqual({ "alpha@1.1.0": true, "@fixture/beta@1.0.1": false })
  })

  it("shows the release that takes the mark in a dry run", async () => {
    const fixture = createMainPackageFixture()
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "Create GitHub Releases in owner/alpha: alpha@1.1.0 (latest), @fixture/beta@1.0.1\n",
    )
  })

  it("leaves the mark in place when the main package is outside the release", async () => {
    const fixture = createMainPackageFixture({ changesets: onlyBeta })
    pushMainPackageTag(fixture)
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Create GitHub Release in owner/alpha: @fixture/beta@1.0.1\n")
    expect(getLatestMarks(fixture)).toEqual({ "@fixture/beta@1.0.1": false })
  })

  it("finds the tag of the main package without a local copy of it", async () => {
    const fixture = createMainPackageFixture({ changesets: onlyBeta })
    pushMainPackageTag(fixture)
    fixture.git("tag", "--delete", "alpha@1.0.0")
    expect((await fixture.run()).error).toBeUndefined()
    expect(getLatestMarks(fixture)).toEqual({ "@fixture/beta@1.0.1": false })
  })

  it("leaves the mark to GitHub without a package named after the repository", async () => {
    const fixture = createFixture({ monorepo: true })
    expect((await fixture.run()).error).toBeUndefined()
    expect(getLatestMarks(fixture)).toEqual({
      "alpha@1.1.0": null,
      "@fixture/beta@1.0.1": null,
    })
  })

  it("does not take a private root package named after the repository for the main package", async () => {
    const fixture = createFixture({
      monorepo: true,
      packageJson: { name: "core", version: "1.0.0" },
    })
    fixture.updateState(state => {
      state.gh.repo = "owner/core"
    })
    expect((await fixture.run()).error).toBeUndefined()
    expect(getLatestMarks(fixture)).toEqual({
      "alpha@1.1.0": null,
      "@fixture/beta@1.0.1": null,
    })
  })

  it("does not take a package without the tag of its version for the main package", async () => {
    const fixture = createMainPackageFixture({ changesets: onlyBeta })
    expect((await fixture.run()).error).toBeUndefined()
    expect(getLatestMarks(fixture)).toEqual({ "@fixture/beta@1.0.1": null })
  })

  it("leaves prereleases to GitHub", async () => {
    const fixture = createMainPackageFixture({ preTag: "beta" })
    const result = await fixture.run()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "Create GitHub Releases in owner/alpha: alpha@1.1.0-beta.0 (prerelease), @fixture/beta@1.0.1-beta.0 (prerelease)\n",
    )
    expect(getLatestMarks(fixture)).toEqual({
      "alpha@1.1.0-beta.0": null,
      "@fixture/beta@1.0.1-beta.0": null,
    })
  })

  describe("on resume", () => {
    /** Runs a release that fails to create its GitHub Releases, then lets GitHub accept them again. */
    async function failGitHubReleases(fixture: Fixture) {
      fixture.updateState(state => {
        state.gh.createFailure = true
      })
      expect((await fixture.run()).error?.message).toContain("HTTP 502")
      fixture.updateState(state => {
        state.gh.createFailure = false
      })
    }

    it("gives the mark to the main package and keeps it from the others", async () => {
      const fixture = createMainPackageFixture()
      await failGitHubReleases(fixture)
      expect((await fixture.run({ resume: true })).error).toBeUndefined()
      expect(getLatestMarks(fixture)).toEqual({ "alpha@1.1.0": true, "@fixture/beta@1.0.1": false })
    })

    it("keeps the mark from the others after the main package got its GitHub Release", async () => {
      const fixture = createMainPackageFixture()
      await failGitHubReleases(fixture)
      fixture.updateState(state => {
        state.gh.releases.push({
          tag: "alpha@1.1.0",
          title: "alpha@1.1.0",
          notes: "",
          prerelease: false,
        })
      })
      expect((await fixture.run({ resume: true })).error).toBeUndefined()
      expect(getLatestMarks(fixture)["@fixture/beta@1.0.1"]).toBe(false)
    })

    it("finds the main package at the release commit after HEAD moved past it", async () => {
      const fixture = createMainPackageFixture({ changesets: onlyBeta })
      pushMainPackageTag(fixture)
      await failGitHubReleases(fixture)
      commitManifest(fixture, "packages/alpha", { version: "2.0.0" })
      expect((await fixture.run({ resume: true })).error).toBeUndefined()
      expect(getLatestMarks(fixture)).toEqual({ "@fixture/beta@1.0.1": false })
    })
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

  describe("superseded release", () => {
    /** Creates a monorepo fixture whose release was published without pushing its tags. */
    async function createPublishedRelease() {
      const fixture = createFixture({ monorepo: true })
      fixture.rejectPushes("refs/tags/*")
      expect((await fixture.run()).error?.message).toContain("rejected")
      fixture.rejectPushes(null)
      return fixture
    }

    it("does not block a new release when HEAD has a higher version of a moved package", async () => {
      const fixture = await createPublishedRelease()
      fixture.git("mv", "packages/alpha", "packages/moved")
      commitManifest(fixture, "packages/moved", { version: "1.2.0" })
      fixture.write(
        ".changeset/next.md",
        changeset("patch", "Fix another bug.", ["alpha", "@fixture/beta"]),
      )
      fixture.git("add", "--all")
      commitManifest(fixture, "packages/beta", { version: "1.0.2" })

      const result = await fixture.run()
      expect(result.error).toBeUndefined()
      expect(result.questions).toEqual(["Release alpha@1.2.1, @fixture/beta@1.0.3?"])
      expectPackageReleased(fixture, "packages/moved", "1.2.1")
      expectPackageReleased(fixture, "packages/beta", "1.0.3")
    })

    it("does not block a new release after a package is extracted to a single-package repository", async () => {
      const fixture = createFixture({
        monorepo: true,
        changesets: { "only-alpha": changeset("minor", "Add a feature.", ["alpha"]) },
      })
      fixture.rejectPushes("refs/tags/*")
      expect((await fixture.run()).error?.message).toContain("rejected")
      fixture.rejectPushes(null)
      const { workspaces: _, private: __, ...root } = JSON.parse(fixture.read("package.json"))
      fixture.git("rm", "--quiet", "-r", "packages")
      fixture.write("package.json", JSON.stringify({ ...root, name: "alpha", version: "1.2.0" }))
      fixture.write(".changeset/next.md", changeset("patch", "Fix another bug.", ["alpha"]))
      fixture.git("add", "--all")
      fixture.git("commit", "--quiet", "--message", "Extract alpha")
      fixture.git("push", "--quiet")

      const result = await fixture.run({ dryRun: true })
      expect(result.error).toBeUndefined()
      expect(result.output).toContain("Release alpha@1.2.1")
    })

    it("blocks a new release when several manifests could be a moved package", async () => {
      const fixture = await createPublishedRelease()
      fixture.git("mv", "packages/alpha", "packages/moved")
      fixture.write(
        "fixtures/alpha/package.json",
        JSON.stringify({ name: "alpha", version: "9.0.0" }),
      )
      fixture.git("add", "--all")
      commitManifest(fixture, "packages/moved", { version: "1.2.0" })
      commitManifest(fixture, "packages/beta", { version: "1.0.2" })

      const result = await fixture.run()
      expect(result.error?.message).toContain("is incomplete")
      expect(result.questions).toEqual([])
    })

    it("blocks a new release while HEAD has the released version of a package", async () => {
      const fixture = await createPublishedRelease()
      commitManifest(fixture, "packages/alpha", { version: "1.2.0" })

      const result = await fixture.run()
      expect(result.error?.message).toContain("is incomplete")
      expect(result.questions).toEqual([])
    })
  })

  it("resumes a release commit that lists its packages in another order", async () => {
    const fixture = createFixture({ monorepo: true })
    fixture.rejectPushes("refs/heads/*")
    expect((await fixture.run()).error?.message).toContain("is incomplete")
    fixture.git(
      "commit",
      "--quiet",
      "--amend",
      "--message",
      "Release @fixture/beta@1.0.1, alpha@1.1.0",
    )
    fixture.rejectPushes(null)
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(fixture.remoteGit("rev-parse", "main")).toBe(fixture.git("rev-parse", "HEAD"))
    expectPackageReleased(fixture, "packages/alpha", "1.1.0")
    expectPackageReleased(fixture, "packages/beta", "1.0.1")
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

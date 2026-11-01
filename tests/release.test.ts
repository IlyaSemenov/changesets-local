import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { changeset, createFixture, expectReleased, packageName } from "./fixture"

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
    expect(result.questions).toEqual([])
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
})

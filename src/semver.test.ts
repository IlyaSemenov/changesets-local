import { describe, expect, it } from "bun:test"

import { compareVersions } from "./semver"

describe("compareVersions", () => {
  it.each([
    ["1.2.0", "2.5.0"],
    ["1.9.0", "1.10.0"],
    ["1.0.9", "1.0.10"],
    ["1.0.0-beta.0", "1.0.0"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-rc.1", "1.0.1"],
    ["1.0.0-beta.9007199254740992.2", "1.0.0-beta.9007199254740993.1"],
  ])("orders %s before %s", (lower, higher) => {
    expect(compareVersions(lower, higher)).toBeLessThan(0)
    expect(compareVersions(higher, lower)).toBeGreaterThan(0)
  })

  it.each([
    ["1.2.3", "1.2.3"],
    ["1.0.0-beta.1", "1.0.0-beta.1"],
    ["1.0.0+build.1", "1.0.0+build.2"],
  ])("treats %s and %s as equal", (a, b) => {
    expect(compareVersions(a, b)).toBe(0)
  })
})

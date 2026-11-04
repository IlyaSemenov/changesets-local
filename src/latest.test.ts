import { describe, expect, it } from "bun:test"

import { getLatestMark } from "./latest"

describe("getLatestMark", () => {
  it("gives the mark to the main package", () => {
    expect(getLatestMark({ name: "core", version: "1.0.0" }, "core")).toBe(true)
  })

  it("keeps the mark away from other packages", () => {
    expect(getLatestMark({ name: "@core/plugin", version: "1.0.0" }, "core")).toBe(false)
  })

  it.each(["core", "@core/plugin"])("leaves a prerelease of %s to GitHub", name => {
    expect(getLatestMark({ name, version: "1.0.0-beta.0" }, "core")).toBeUndefined()
  })

  it("leaves a repository without a main package to GitHub", () => {
    expect(getLatestMark({ name: "@core/plugin", version: "1.0.0" }, null)).toBeUndefined()
  })
})

import { describe, expect, it } from "bun:test"

import { formatReleaseSubject, parseReleaseSubject, sortByName } from "./packages"

describe("parseReleaseSubject", () => {
  it("parses the subject of a release", () => {
    const releases = [
      { name: "@acme/core", version: "2.1.0" },
      { name: "kern", version: "1.0.0-beta.1" },
    ]
    expect(parseReleaseSubject(formatReleaseSubject(releases))).toEqual(releases)
  })

  it("parses packages in any order", () => {
    expect(parseReleaseSubject("Release b@1.0.0, a@2.0.0")).toEqual([
      { name: "b", version: "1.0.0" },
      { name: "a", version: "2.0.0" },
    ])
  })

  it.each([
    "Release 1.2.3",
    "Release v1.2.3",
    "Release @acme/core",
    "Release a@1.0.0 and b@2.0.0",
    "Release a@1.0.0,b@2.0.0",
    "Releases a@1.0.0",
  ])("rejects %p", subject => {
    expect(parseReleaseSubject(subject)).toBeNull()
  })
})

describe("sortByName", () => {
  it("sorts scoped packages by their name without the @", () => {
    const names = ["zeta", "@kern-orm/postgres-js", "kern-orm", "@acme/core"]
    expect(sortByName(names.map(name => ({ name }))).map(entry => entry.name)).toEqual([
      "@acme/core",
      "kern-orm",
      "@kern-orm/postgres-js",
      "zeta",
    ])
  })
})

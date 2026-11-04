import { expect, it } from "bun:test"

import { listReleasedDependencies } from "./dependencies"

const releases = [{ name: "core" }, { name: "tool" }, { name: "types" }, { name: "utils" }]

it("lists released runtime dependencies once and in the order of the releases", () => {
  const manifest = {
    name: "plugin",
    version: "1.0.0",
    dependencies: { utils: "^1.0.0", core: "^1.0.0", other: "^1.0.0" },
    optionalDependencies: { tool: "^1.0.0" },
    peerDependencies: { core: "^1.0.0", types: "^1.0.0" },
  }
  expect(listReleasedDependencies(manifest, releases).map(release => release.name)).toEqual([
    "core",
    "tool",
    "types",
    "utils",
  ])
})

it("ignores development dependencies", () => {
  const manifest = { name: "plugin", version: "1.0.0", devDependencies: { core: "^1.0.0" } }
  expect(listReleasedDependencies(manifest, releases)).toEqual([])
})

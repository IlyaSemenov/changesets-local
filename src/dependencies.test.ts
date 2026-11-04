import { describe, expect, it } from "bun:test"

import {
  diffDependencyRanges,
  formatDependencyRangeChange,
  formatUnreleasedRangeWarning,
  listReleasedDependencies,
} from "./dependencies"

const base = { name: "plugin", version: "1.0.0" }

describe("listReleasedDependencies", () => {
  const releases = [{ name: "core" }, { name: "tool" }, { name: "types" }, { name: "utils" }]

  it("lists released runtime dependencies once and in the order of the releases", () => {
    const manifest = {
      ...base,
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
    const manifest = { ...base, devDependencies: { core: "^1.0.0" } }
    expect(listReleasedDependencies(manifest, releases)).toEqual([])
  })
})

describe("diffDependencyRanges", () => {
  it("lists changed, added, and removed ranges by field and dependency name", () => {
    expect(
      diffDependencyRanges(
        {
          ...base,
          dependencies: { same: "^1.0.0", zeta: "^1.0.0", changed: "^1.0.0" },
          peerDependencies: { removed: "^1.0.0" },
        },
        {
          ...base,
          dependencies: { same: "^1.0.0", zeta: "^2.0.0", changed: "^2.0.0" },
          optionalDependencies: { added: "^1.0.0" },
        },
      ),
    ).toEqual([
      { field: "dependencies", dependency: "changed", before: "^1.0.0", after: "^2.0.0" },
      { field: "dependencies", dependency: "zeta", before: "^1.0.0", after: "^2.0.0" },
      { field: "optionalDependencies", dependency: "added", before: null, after: "^1.0.0" },
      { field: "peerDependencies", dependency: "removed", before: "^1.0.0", after: null },
    ])
  })

  it("reports a dependency moved to another field as a removal and an addition", () => {
    expect(
      diffDependencyRanges(
        { ...base, dependencies: { core: "^1.0.0" } },
        { ...base, peerDependencies: { core: "^1.0.0" } },
      ),
    ).toEqual([
      { field: "dependencies", dependency: "core", before: "^1.0.0", after: null },
      { field: "peerDependencies", dependency: "core", before: null, after: "^1.0.0" },
    ])
  })

  it("handles a dependency named like an inherited object property", () => {
    const manifest = { ...base, dependencies: { constructor: "^1.0.0" } }
    const change = { field: "dependencies", dependency: "constructor" } as const
    expect(diffDependencyRanges(base, manifest)).toEqual([
      { ...change, before: null, after: "^1.0.0" },
    ])
    expect(diffDependencyRanges(manifest, base)).toEqual([
      { ...change, before: "^1.0.0", after: null },
    ])
  })

  it("ignores development dependencies", () => {
    const before = { ...base, devDependencies: { core: "^1.0.0" } }
    const after = { ...base, devDependencies: { core: "^2.0.0" } }
    expect(diffDependencyRanges(before, after)).toEqual([])
  })
})

describe("formatDependencyRangeChange", () => {
  const change = { field: "dependencies", dependency: "core" } as const

  it("formats a changed range", () => {
    expect(formatDependencyRangeChange({ ...change, before: "^1.0.0", after: "^2.0.0" })).toBe(
      "dependencies core ^1.0.0 → ^2.0.0",
    )
  })

  it("formats an added dependency", () => {
    expect(formatDependencyRangeChange({ ...change, before: null, after: "^2.0.0" })).toBe(
      "dependencies core added ^2.0.0",
    )
  })

  it("formats a removed dependency", () => {
    expect(formatDependencyRangeChange({ ...change, before: "^1.0.0", after: null })).toBe(
      "dependencies core ^1.0.0 → removed",
    )
  })
})

describe("formatUnreleasedRangeWarning", () => {
  const entry = { name: "plugin", version: "0.1.1" }

  it("names the published and the local range of a dependency", () => {
    expect(
      formatUnreleasedRangeWarning({
        ...entry,
        changes: [
          { field: "dependencies", dependency: "core", before: "^0.2.0", after: ">=0.2.0 <1" },
        ],
      }),
    ).toBe(
      "plugin@0.1.1 is published with core ^0.2.0, but package.json now has >=0.2.0 <1.\n  Add a changeset for plugin to publish this change.",
    )
  })

  it("describes a dependency moved to another field", () => {
    expect(
      formatUnreleasedRangeWarning({
        ...entry,
        changes: [
          { field: "dependencies", dependency: "core", before: "^0.2.0", after: null },
          { field: "peerDependencies", dependency: "core", before: null, after: "^0.2.0" },
        ],
      }),
    ).toBe(
      [
        "plugin@0.1.1 is published with core ^0.2.0 in dependencies, but package.json no longer has it there.",
        "  plugin@0.1.1 is published without core in peerDependencies, but package.json now has ^0.2.0 there.",
        "  Add a changeset for plugin to publish these changes.",
      ].join("\n"),
    )
  })
})

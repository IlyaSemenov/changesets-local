import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { extractChangelogEntry } from "./changelog"

function readFixture(name: string) {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
}

describe("extractChangelogEntry", () => {
  // The 1.1.0 notes contain "## 1.0.0" headings in a code block, which must not end the section or match the version, and a fence line with an info string, which does not close the block.
  const changelog = readFixture("changelog.md")

  it.each(["1.1.0", "1.0.0"])("extracts the notes of %s", version => {
    expect(extractChangelogEntry(changelog, version)).toBe(
      readFixture(`changelog-${version}.md`).trimEnd(),
    )
  })

  it("returns undefined for a missing version", () => {
    expect(extractChangelogEntry(changelog, "2.0.0")).toBeUndefined()
  })
})

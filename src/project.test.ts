import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readWorkTreeFiles } from "./project"

describe("readWorkTreeFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "changesets-local-test-"))
  writeFileSync(join(dir, "package.json"), "{}")
  mkdirSync(join(dir, "folder"))
  const readRepoFile = readWorkTreeFiles(dir)

  it("reads a file", async () => {
    expect(await readRepoFile("package.json")).toBe("{}")
  })

  it("returns null for a missing file", async () => {
    expect(await readRepoFile("missing.json")).toBeNull()
  })

  it("fails when a path cannot be read", async () => {
    await expect(readRepoFile("folder")).rejects.toThrow("EISDIR")
  })
})

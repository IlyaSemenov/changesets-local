import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getWorkTreeFiles } from "./project"

describe("getWorkTreeFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "changesets-local-test-"))
  writeFileSync(join(dir, "package.json"), "{}")
  mkdirSync(join(dir, "folder"))
  const files = getWorkTreeFiles(dir)

  it("reads a file", async () => {
    expect(await files.read("package.json")).toBe("{}")
  })

  it("returns null for a missing file", async () => {
    expect(await files.read("missing.json")).toBeNull()
  })

  it("fails when a path cannot be read", async () => {
    await expect(files.read("folder")).rejects.toThrow("EISDIR")
  })

  it("checks whether a file exists", async () => {
    expect(await files.exists("package.json")).toBe(true)
    expect(await files.exists("missing.json")).toBe(false)
  })

  it("fails when a path cannot be checked", async () => {
    await expect(files.exists("package.json/child")).rejects.toThrow("ENOTDIR")
  })
})

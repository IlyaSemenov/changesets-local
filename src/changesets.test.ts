import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { filterVersionOutput } from "./changesets"

it("preserves warnings while removing the banner and commit advice", () => {
  const output = readFileSync(
    join(import.meta.dir, "fixtures", "changeset-version-output.txt"),
    "utf8",
  )
  expect(filterVersionOutput(output)).toBe(
    'Found issues in your config:\n- fixed: Invalid path: The package or glob "nonexistent-*" does not match any package in the project. Note that glob expressions must be defined according to https://npmx.dev/picomatch.',
  )
})

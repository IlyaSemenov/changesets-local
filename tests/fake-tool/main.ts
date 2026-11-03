// Fake npm, pnpm, and gh for release tests, run as `bun main.ts <tool> <args...>` through shims on PATH.
// The shim is the script of this interpreter, so its name tells which tool is faked.
import { appendFileSync } from "node:fs"
import { basename, join } from "node:path"

import { fail, type FakeCommand } from "./call"
import { runGh } from "./gh"
import { runNpm } from "./npm"
import { readFakeState } from "./state"

const tools: Record<string, FakeCommand> = { npm: runNpm, pnpm: runNpm, gh: runGh }

const [script, ...args] = process.argv.slice(2)
const tool = basename(script!)
const stateDir = process.env.FAKE_STATE_DIR!
appendFileSync(join(stateDir, "calls.ndjson"), `${JSON.stringify([tool, ...args])}\n`)
const runTool = tools[tool] ?? fail(`unknown fake tool ${tool}`)
runTool({ tool, args, stateDir, state: readFakeState(stateDir) })

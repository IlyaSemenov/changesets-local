#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs, styleText } from "node:util"

import { version } from "../package.json"

import { type Context, ReleaseError } from "./context"
import { release } from "./release"

/** Milliseconds that the terminal gets to deliver input typed before a prompt. */
const pendingInputDrainTime = 50

const help = `Usage: changesets-local [options]

Release the packages of the repository in the current directory from pending changesets:
version them, publish them to npm, push the release commit and tags, and create GitHub Releases.

Options:
  --dry-run      Show what a release would do without changing anything
  --resume       Finish an interrupted release
  -h, --help     Show this help
  -v, --version  Show the changesets-local version`

/** Runs the command line interface. */
async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      resume: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }
  if (values.version) {
    console.log(version)
    return
  }

  if (!values["dry-run"] && !process.stdin.isTTY) {
    throw new ReleaseError("A release needs an interactive terminal.")
  }

  // Ctrl+C reaches subprocesses sharing the terminal; the release then fails and cleans up instead of exiting midway.
  // A second Ctrl+C exits at once, for a subprocess that does not stop.
  const controller = new AbortController()
  const interrupt = () => {
    if (controller.signal.aborted) {
      console.error(`\n${styleText("red", "✘")} Exited without cleanup; check \`git status\`.`)
      process.exit(130)
    }
    controller.abort()
  }
  process.on("SIGINT", interrupt)
  const ctx: Context = {
    cwd: process.cwd(),
    env: process.env,
    interactive: true,
    pollInterval: 10_000,
    presenceTimeout: 10_000,
    signal: controller.signal,
    log: line => console.log(line),
    confirm: question => askConfirmation(question, interrupt),
    waitForUser: message => waitForEnter(message, interrupt),
  }
  await release(ctx, { dryRun: values["dry-run"], resume: values.resume })
}

/** Asks a yes/no question in the terminal; Ctrl+C answers no. */
async function askConfirmation(question: string, interrupt: () => void) {
  const answer = await readAnswer(`\n${styleText("bold", question)} [y/N] `, interrupt)
  return answer !== null && /^y(es)?$/i.test(answer.trim())
}

/** Rings the terminal bell and waits for Enter, resolving to false on Ctrl+C. */
async function waitForEnter(message: string, interrupt: () => void) {
  process.stdout.write("\x07")
  return (await readAnswer(`\n${styleText("bold", message)} `, interrupt)) !== null
}

/**
 * Reads a line typed in the terminal after a prompt, or resolves to null on Ctrl+C.
 *
 * Ctrl+C calls `interrupt`: the terminal sends it to readline instead of the process.
 */
async function readAnswer(prompt: string, interrupt: () => void) {
  if (await discardPendingInput()) {
    interrupt()
    console.log()
    return null
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  rl.on("SIGINT", () => {
    controller.abort()
    interrupt()
  })
  try {
    return await rl.question(prompt, { signal: controller.signal })
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      console.log()
      return null
    }
    throw error
  } finally {
    rl.close()
  }
}

/**
 * Discards keys pressed before a prompt, so that a stray Enter during long checks does not answer it.
 *
 * Node.js cannot flush the terminal queue, so this reads the queue for a moment in raw mode, which also delivers an unfinished line.
 * Resolves to whether Ctrl+C was pressed meanwhile: raw mode delivers it as input instead of a signal.
 */
async function discardPendingInput() {
  const { stdin } = process
  let interrupted = false
  const discard = (chunk: Buffer) => {
    interrupted ||= chunk.includes(0x03)
  }
  stdin.setRawMode(true)
  stdin.on("data", discard)
  stdin.resume()
  await sleep(pendingInputDrainTime)
  stdin.off("data", discard)
  stdin.pause()
  stdin.setRawMode(false)
  return interrupted
}

try {
  await main()
} catch (error) {
  if (
    error instanceof ReleaseError ||
    (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")
  ) {
    console.error(`\n${styleText("red", "✘")} ${(error as Error).message}`)
  } else {
    console.error(error)
  }
  process.exitCode = 1
}

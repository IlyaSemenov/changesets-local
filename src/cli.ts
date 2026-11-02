#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { parseArgs, styleText } from "node:util"

import { version } from "../package.json"

import { type Context, ReleaseError } from "./context"
import { release } from "./release"

const help = `Usage: changesets-local [options]

Release the packages of the repository in the current directory from pending changesets:
version them, publish them to npm, push the release commit and tags, and create GitHub Releases.

Options:
  --dry-run      Show what a release would do without changing anything
  --resume       Finish the newest release
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
    signal: controller.signal,
    log: line => console.log(line),
    confirm: question => askConfirmation(question, interrupt),
  }
  await release(ctx, { dryRun: values["dry-run"], resume: values.resume })
}

/**
 * Asks a yes/no question in the terminal.
 *
 * Ctrl+C answers no and calls `interrupt`: the terminal sends it to readline instead of the process.
 */
async function askConfirmation(question: string, interrupt: () => void) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  rl.on("SIGINT", () => {
    controller.abort()
    interrupt()
  })
  try {
    const answer = await rl.question(`\n${styleText("bold", question)} [y/N] `, {
      signal: controller.signal,
    })
    return /^y(es)?$/i.test(answer.trim())
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      console.log()
      return false
    }
    throw error
  } finally {
    rl.close()
  }
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

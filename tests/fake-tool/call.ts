// A command run through a fake tool, and helpers that tool handlers share.
import type { FakeState } from "./state"

/** A command run through a fake tool. */
export interface FakeCall {
  /** Name of the faked tool, such as `npm`. */
  tool: string
  args: string[]
  /** Directory of the fake state and the call log. */
  stateDir: string
  /** Fake state when the command started; change it with `updateFakeState`. */
  state: FakeState
}

/** Handler of one command of a fake tool. */
export type FakeCommand = (call: FakeCall) => void

/** Prints an error message and exits with a non-zero code. */
export function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/**
 * Finds the handler of a command by its first two arguments, such as `repo view`, or by its first argument.
 */
export function findCommand(commands: Record<string, FakeCommand>, args: string[]) {
  return commands[args.slice(0, 2).join(" ")] ?? commands[args[0] ?? ""]
}

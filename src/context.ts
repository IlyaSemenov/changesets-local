import { styleText } from "node:util"

/**
 * The environment a release runs in: the project location, subprocess settings, and the terminal interface.
 *
 * The CLI builds it from the real process; tests build it with fake tools and scripted answers.
 */
export interface Context {
  /** Root of the released project: a Git work tree root with `package.json`. */
  cwd: string
  /** Environment variables for every subprocess. */
  env: NodeJS.ProcessEnv
  /**
   * Whether long-running and interactive subprocesses share the terminal.
   * When false, their output is captured and reported only on failure.
   */
  interactive: boolean
  /** Aborts the release before the next subprocess starts. */
  signal?: AbortSignal
  /** Prints a line of output. */
  log: (line: string) => void
  /** Asks a yes/no question and resolves to the answer. */
  confirm: (question: string) => Promise<boolean>
}

/** An expected failure with an actionable message for the user, printed without a stack trace. */
export class ReleaseError extends Error {
  override name = "ReleaseError"
}

/** Prints the heading of a release step. */
export function logStep(ctx: Context, text: string) {
  ctx.log(styleText("bold", `\n▸ ${text}`))
}

/** Prints a dimmed secondary line, such as a command being run. */
export function logDetail(ctx: Context, text: string) {
  ctx.log(styleText("dim", text))
}

/** Prints a line marking a completed action. */
export function logDone(ctx: Context, text: string) {
  ctx.log(`${styleText("green", "✔")} ${text}`)
}

/** Prints a warning about a problem that does not stop the command. */
export function logWarning(ctx: Context, text: string) {
  ctx.log(`${styleText("yellow", "⚠")} ${text}`)
}

import { spawn } from "node:child_process"

import { type Context, logDetail, ReleaseError } from "./context"

/** Options of a subprocess. */
export interface CommandOptions {
  /** Working directory; defaults to the project root. */
  cwd?: string
  /** Extra environment variables on top of the context environment. */
  env?: NodeJS.ProcessEnv
  /** Text written to the standard input. */
  input?: string
}

/** Exit status and output of a captured subprocess. */
export interface CommandResult {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs a subprocess and captures its output.
 *
 * Resolves for any exit code; rejects only when the command cannot be started.
 */
export function captureCommand(
  ctx: Context,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return spawnCommand(ctx, command, args, options, false)
}

/**
 * Runs a subprocess, captures its output, and returns the standard output without trailing whitespace.
 *
 * Fails with the command's error output when it exits with a non-zero code.
 */
export async function readCommand(
  ctx: Context,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const result = await captureCommand(ctx, command, args, options)
  if (result.code !== 0) {
    throw new ReleaseError(describeFailure(command, args, result))
  }
  return result.stdout.trimEnd()
}

/**
 * Runs a subprocess that changes something or takes long, printing the command first.
 *
 * In an interactive context, the subprocess shares the terminal, so it can show progress and ask for input such as npm 2FA.
 * Fails when it exits with a non-zero code.
 */
export async function runCommand(
  ctx: Context,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<void> {
  const result = await runCommandWithStatus(ctx, command, args, options)
  if (result.code !== 0) {
    throw new ReleaseError(describeFailure(command, args, result))
  }
}

/** Runs a subprocess like `runCommand`, but resolves with its status instead of failing on a non-zero exit code. */
export function runCommandWithStatus(
  ctx: Context,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  logDetail(ctx, `$ ${formatCommand(command, args)}`)
  return spawnCommand(ctx, command, args, options, ctx.interactive)
}

/** Formats a command line for display. */
export function formatCommand(command: string, args: string[]) {
  return [command, ...args]
    .map(arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)))
    .join(" ")
}

function spawnCommand(
  ctx: Context,
  command: string,
  args: string[],
  options: CommandOptions,
  inherit: boolean,
): Promise<CommandResult> {
  if (ctx.signal?.aborted) {
    return Promise.reject(new ReleaseError("Interrupted."))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ctx.cwd,
      env: { ...ctx.env, ...options.env },
      stdio: [
        options.input === undefined && inherit ? "inherit" : "pipe",
        inherit ? "inherit" : "pipe",
        inherit ? "inherit" : "pipe",
      ],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new ReleaseError(`\`${command}\` is not installed or not on PATH.`)
          : error,
      )
    })
    child.on("close", code => resolve({ code, stdout, stderr }))
    if (child.stdin) {
      child.stdin.end(options.input ?? "")
    }
  })
}

/** Describes a failed command with the last lines of its error output, or of its standard output when it printed no errors. */
export function describeFailure(command: string, args: string[], result: CommandResult) {
  const status = result.code === null ? "was interrupted" : `failed with exit code ${result.code}`
  const output = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-20).join("\n")
  return `\`${formatCommand(command, args)}\` ${status}.${output ? `\n${output}` : ""}`
}

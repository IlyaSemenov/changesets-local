// CI checks of the released commit: waiting for them before the confirmation and asking before releasing a commit whose CI has failed.
import { setTimeout as sleep } from "node:timers/promises"

import {
  type Context,
  formatList,
  logDetail,
  logDone,
  logStep,
  logWarning,
  ReleaseError,
} from "./context"
import { type CommitCheck, listCommitChecks } from "./github"

/** A commit whose CI must be checked again before the release confirmation. */
export interface PendingChecks {
  commit: string
}

/**
 * Asks whether to release a commit whose CI checks have already failed, and fails when the user declines.
 *
 * Returns the context for the later call to `awaitChecks`, or null when the user accepted failed checks.
 */
export async function confirmFailedChecks(
  ctx: Context,
  repo: string,
  commit: string,
): Promise<PendingChecks | null> {
  const checks = await listCommitChecks(ctx, repo, commit)
  if (hasFailures(checks)) {
    await confirmRelease(ctx, commit, checks)
    return null
  }
  if (isRunning(checks)) {
    logDetail(
      ctx,
      `CI is running on ${commit.slice(0, 7)}: ${formatCheckNames(checks, "pending")}.`,
    )
  }
  return { commit }
}

/** Waits until the CI checks of a commit finish or one fails, and asks whether to release the commit when one fails. */
export async function awaitChecks(ctx: Context, repo: string, pending: PendingChecks) {
  const { commit } = pending
  const short = commit.slice(0, 7)
  let checks = await listCommitChecks(ctx, repo, commit)
  let running = ""
  while (isRunning(checks)) {
    if (!running) {
      logStep(ctx, `Waiting for CI on ${short}`)
    }
    const names = formatCheckNames(checks, "pending")
    if (names !== running) {
      logDetail(ctx, `Running: ${names}`)
      running = names
    }
    await delay(ctx, ctx.pollInterval)
    checks = await listCommitChecks(ctx, repo, commit)
  }
  if (hasFailures(checks)) {
    await confirmRelease(ctx, commit, checks)
  } else if (checks.length > 0) {
    logDone(ctx, `CI passed on ${short}`)
  }
}

/** Shows the CI state of a commit in a dry run, warning about failed or running checks. */
export async function previewChecks(ctx: Context, repo: string, commit: string) {
  const short = commit.slice(0, 7)
  const checks = await listCommitChecks(ctx, repo, commit)
  if (hasFailures(checks)) {
    logWarning(ctx, formatFailures(commit, checks))
  } else if (isRunning(checks)) {
    logWarning(
      ctx,
      `CI is running on ${short}: ${formatCheckNames(checks, "pending")}. A release waits for it before the confirmation.`,
    )
  } else if (checks.length > 0) {
    logDone(ctx, `CI passed on ${short}`)
  }
}

/** Asks whether to release a commit despite its failed checks, and fails when the user declines. */
async function confirmRelease(ctx: Context, commit: string, checks: CommitCheck[]) {
  logWarning(ctx, formatFailures(commit, checks))
  if (!(await ctx.confirm("Release despite the failed CI?"))) {
    throw new ReleaseError("Release cancelled.")
  }
}

/** Sleeps for a number of milliseconds, failing when the release is interrupted. */
async function delay(ctx: Context, ms: number) {
  try {
    await sleep(ms, undefined, { signal: ctx.signal })
  } catch (error) {
    throw (error as Error).name === "AbortError" ? new ReleaseError("Interrupted.") : error
  }
}

function hasFailures(checks: CommitCheck[]) {
  return checks.some(check => check.state === "failure")
}

/** Returns whether some checks are running and none has failed: a failure settles the CI without waiting for the rest. */
function isRunning(checks: CommitCheck[]) {
  return checks.some(check => check.state === "pending") && !hasFailures(checks)
}

function formatFailures(commit: string, checks: CommitCheck[]) {
  const failed = checks.filter(check => check.state === "failure")
  return `CI failed on ${commit.slice(0, 7)}:\n${formatList(failed.map(formatCheck))}`
}

function formatCheckNames(checks: CommitCheck[], state: CommitCheck["state"]) {
  return checks
    .filter(check => check.state === state)
    .map(check => check.name)
    .join(", ")
}

function formatCheck(check: CommitCheck) {
  return check.url ? `${check.name}: ${check.url}` : check.name
}

// CI checks of the released commit: waiting for them before publishing and asking before releasing a commit whose CI has failed.
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
import { getCommitFiles } from "./git"
import { type CommitCheck, GitHubAccessError, listCommitChecks } from "./github"

/** Poll intervals after the first read in which GitHub may still be creating the check runs of a just pushed commit. */
const checkCreationPolls = 2

/** Attempts to read CI checks before a failure other than missing access stops the release. */
const maxReadAttempts = 3

/** A commit whose CI must be checked again before the release commit. */
export interface PendingChecks {
  commit: string
  /** Time of the first read of the checks, in milliseconds since the epoch. */
  readAt: number
}

/**
 * Asks whether to release a commit whose CI checks have already failed, and fails when the user declines.
 *
 * Returns the context for the later call to `awaitChecks`, or null when the user accepted failed checks or the checks cannot be read.
 */
export async function confirmFailedChecks(
  ctx: Context,
  repo: string,
  commit: string,
): Promise<PendingChecks | null> {
  const readAt = Date.now()
  const checks = await readChecks(ctx, repo, commit)
  if (!checks) {
    return null
  }
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
  return { commit, readAt }
}

/**
 * Waits until the CI checks of a commit finish or one fails, and asks whether to release the commit when one fails.
 *
 * Resolves to whether it asked, which means that the user has just answered in the terminal.
 * Does not wait for checks awaiting approval, such as a deployment to a protected environment.
 * When the commit has GitHub Actions workflows but no checks, reads them again once GitHub has had time to create them.
 */
export async function awaitChecks(ctx: Context, repo: string, pending: PendingChecks) {
  const { commit } = pending
  const short = commit.slice(0, 7)
  let waiting = false
  const startWaiting = () => {
    if (!waiting) {
      logStep(ctx, `Waiting for CI on ${short}`)
      waiting = true
    }
  }
  let checks = await rereadChecks(ctx, repo, commit)
  if (checks.length === 0 && (await getCommitFiles(ctx, commit).exists(".github/workflows"))) {
    const remaining = pending.readAt + checkCreationPolls * ctx.pollInterval - Date.now()
    if (remaining > 0) {
      startWaiting()
      logDetail(ctx, "Waiting for GitHub to create the checks")
      await delay(ctx, remaining)
    }
    checks = await rereadChecks(ctx, repo, commit)
    if (waiting && checks.length === 0) {
      logDetail(ctx, `No CI checks on ${short}`)
    }
  }
  let running = ""
  while (isRunning(checks)) {
    startWaiting()
    const names = formatCheckNames(checks, "pending")
    if (names !== running) {
      logDetail(ctx, `Running: ${names}`)
      running = names
    }
    await delay(ctx, ctx.pollInterval)
    checks = await rereadChecks(ctx, repo, commit)
  }
  if (hasFailures(checks)) {
    await confirmRelease(ctx, commit, checks)
    return true
  }
  warnAboutApprovals(ctx, commit, checks)
  if (checks.some(check => check.state === "success")) {
    logDone(ctx, `CI passed on ${short}`)
  }
  return false
}

/** Shows the CI state of a commit in a dry run, warning about failed or running checks. */
export async function previewChecks(ctx: Context, repo: string, commit: string) {
  const short = commit.slice(0, 7)
  const checks = await readChecks(ctx, repo, commit)
  if (!checks) {
    return
  }
  if (hasFailures(checks)) {
    logWarning(ctx, formatFailures(commit, checks))
    return
  }
  warnAboutApprovals(ctx, commit, checks)
  if (isRunning(checks)) {
    logWarning(
      ctx,
      `CI is running on ${short}: ${formatCheckNames(checks, "pending")}. A release waits for it before publishing.`,
    )
  } else if (checks.some(check => check.state === "success")) {
    logDone(ctx, `CI passed on ${short}`)
  }
}

/**
 * Lists the CI checks of a commit for the first time, or warns and returns null when the token cannot access them.
 *
 * A token without access to checks or statuses must not block releases, as a repository without CI does not.
 */
async function readChecks(ctx: Context, repo: string, commit: string) {
  try {
    return await readChecksWithRetries(ctx, repo, commit)
  } catch (error) {
    if (!(error instanceof GitHubAccessError)) {
      throw error
    }
    logWarning(
      ctx,
      `Cannot read CI checks on ${commit.slice(0, 7)}; skipping them.\n${error.message}`,
    )
    return null
  }
}

/** Lists the CI checks of a commit that were read before, failing instead of skipping them when the token has lost access. */
async function rereadChecks(ctx: Context, repo: string, commit: string) {
  try {
    return await readChecksWithRetries(ctx, repo, commit)
  } catch (error) {
    if (!(error instanceof GitHubAccessError)) {
      throw error
    }
    throw new ReleaseError(`Cannot read CI checks on ${commit.slice(0, 7)}.\n${error.message}`)
  }
}

/**
 * Lists the CI checks of a commit, retrying a read that fails for a reason other than missing access, such as a network error, after a poll interval.
 *
 * Fails after `maxReadAttempts` failed reads in a row: skipping readable checks could release a commit whose CI fails.
 */
async function readChecksWithRetries(ctx: Context, repo: string, commit: string) {
  const short = commit.slice(0, 7)
  for (let attempt = 1; ; attempt++) {
    try {
      return await listCommitChecks(ctx, repo, commit)
    } catch (error) {
      if (
        !(error instanceof ReleaseError) ||
        error instanceof GitHubAccessError ||
        ctx.signal?.aborted
      ) {
        throw error
      }
      if (attempt >= maxReadAttempts) {
        throw new ReleaseError(
          `Cannot read CI checks on ${short} after ${maxReadAttempts} attempts.\n${error.message}`,
        )
      }
      logDetail(ctx, `Cannot read CI checks on ${short}; retrying.`)
      await delay(ctx, ctx.pollInterval)
    }
  }
}

/** Asks whether to release a commit despite its failed checks, and fails when the user declines. */
async function confirmRelease(ctx: Context, commit: string, checks: CommitCheck[]) {
  logWarning(ctx, formatFailures(commit, checks))
  if (!(await ctx.confirm("Release despite the failed CI?"))) {
    throw new ReleaseError("Release cancelled.")
  }
}

function warnAboutApprovals(ctx: Context, commit: string, checks: CommitCheck[]) {
  const names = formatCheckNames(checks, "waiting")
  if (names) {
    logWarning(
      ctx,
      `Not waiting for CI checks on ${commit.slice(0, 7)} that require approval: ${names}.`,
    )
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

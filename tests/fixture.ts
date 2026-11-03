// Temporary single-package repositories and monorepos with a bare Git remote and fake npm, pnpm, and gh for release tests.
import { expect } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { stripVTControlCharacters } from "node:util"

import { extractChangelogEntry } from "../src/changelog"
import type { Context } from "../src/context"
import { release, type ReleaseOptions } from "../src/release"

import { createFakeState, type FakeState, readFakeState, updateFakeState } from "./fake-tool/state"

const repoRoot = dirname(import.meta.dir)

/** Real tools on PATH for fixture subprocesses; npm, pnpm, and gh are faked, and anything else is not on PATH. */
const realTools = ["bun", "git", "node", "sh"]

/** Package name of the single-package fixture project. */
export const packageName = "fixture-package"

/** Public packages of the monorepo fixture by directory, published at 1.0.0. */
export const monorepoPackages = { "packages/alpha": "alpha", "packages/beta": "@fixture/beta" }

/** Private package of the monorepo fixture, which depends on `alpha` through the workspace. */
export const privatePackage = { dir: "packages/example", name: "@fixture/example" }

/** Options of a fixture project. */
export interface FixtureOptions {
  packageManager?: "npm" | "pnpm" | "bun"
  /** Changeset files by name, committed as pending changesets. */
  changesets?: Record<string, string>
  /** Creates a monorepo with `monorepoPackages` and `privatePackage` instead of a single package. */
  monorepo?: boolean
  /** Extra fields of the root package.json. */
  packageJson?: Record<string, unknown>
  /** Extra fields of monorepo package manifests by package directory. */
  packages?: Record<string, Record<string, unknown>>
  /** Extra fields of the Changesets config. */
  changesetsConfig?: Record<string, unknown>
  /** Enters Changesets prerelease mode with this tag. */
  preTag?: string
}

/** Output of a release run. */
export interface RunResult {
  output: string
  /** Confirmation questions asked. */
  questions: string[]
  error?: Error
}

/** A fixture project and helpers to run releases in it and inspect the outcome. */
export interface Fixture {
  /** Project work tree. */
  dir: string
  /** Bare Git repository used as `origin`. */
  remote: string
  env: NodeJS.ProcessEnv
  /**
   * Runs a release, answering confirmation questions with `confirm`.
   * With `abort`, aborts the context signal when asked for confirmation, as Ctrl+C does; with `abortOnLog`, when a printed line contains that text.
   */
  run: (
    options?: ReleaseOptions,
    answers?: { confirm?: boolean; abort?: boolean; abortOnLog?: string },
  ) => Promise<RunResult>
  /** Runs Git in the project and returns its trimmed output. */
  git: (...args: string[]) => string
  /** Runs Git in the remote repository and returns its trimmed output. */
  remoteGit: (...args: string[]) => string
  /** Reads a project file. */
  read: (path: string) => string
  /** Writes a project file. */
  write: (path: string, content: string) => void
  /** Reads the fake npm and GitHub state. */
  state: () => FakeState
  /** Changes the fake npm and GitHub state. */
  updateState: (update: (state: FakeState) => void) => void
  /** Lists commands run through a fake tool. */
  calls: (tool: "npm" | "pnpm" | "gh") => string[][]
  /** Installs an executable Git hook in the project repository. */
  installHook: (name: string, script: string) => void
  /** Removes a fake tool from PATH. */
  removeTool: (tool: "npm" | "pnpm" | "gh") => void
  /** Makes the remote reject pushes of refs matching a shell pattern, or accept everything again with null. */
  rejectPushes: (pattern: string | null) => void
}

/** Returns a shell command that changes top-level fields of a JSON file with Node.js. */
export function createJsonEditCommand(path: string, fields: Record<string, unknown>) {
  return `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('${path}'));Object.assign(p,${JSON.stringify(fields).replaceAll('"', "'")});fs.writeFileSync('${path}',JSON.stringify(p))"`
}

/** Creates a changeset file content that bumps packages, by default the single-package fixture. */
export function changeset(
  type: "major" | "minor" | "patch",
  summary: string,
  names = [packageName],
) {
  return `---\n${names.map(name => `"${name}": ${type}`).join("\n")}\n---\n\n${summary}\n`
}

/** Asserts that a completed release of a version is in Git, npm, and GitHub, with HEAD at the release commit. */
export function expectReleased(fixture: Fixture, version: string) {
  const tag = `v${version}`
  const head = fixture.git("rev-parse", "HEAD")
  expect(fixture.git("log", "-1", "--format=%s")).toBe(`Release ${packageName}@${version}`)
  expect(JSON.parse(fixture.read("package.json")).version).toBe(version)
  expect(fixture.git("status", "--porcelain")).toBe("")
  expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
  expect(fixture.remoteGit("rev-parse", `${tag}^{commit}`)).toBe(head)
  expect(fixture.remoteGit("cat-file", "-t", tag)).toBe("tag")
  expect(fixture.state().npm.versions[packageName]).toContain(version)
  const release = fixture.state().gh.releases.find(entry => entry.tag === tag)
  expect(release?.title).toBe(tag)
  expect(release?.notes).toBe(extractChangelogEntry(fixture.read("CHANGELOG.md"), version)!)
}

/** Asserts that a package version of a monorepo release is published, tagged at HEAD, and has a GitHub Release with its notes. */
export function expectPackageReleased(fixture: Fixture, dir: string, version: string) {
  const name = JSON.parse(fixture.read(`${dir}/package.json`)).name as string
  const tag = `${name}@${version}`
  expect(JSON.parse(fixture.read(`${dir}/package.json`)).version).toBe(version)
  expect(fixture.remoteGit("rev-parse", `${tag}^{commit}`)).toBe(fixture.git("rev-parse", "HEAD"))
  expect(fixture.state().npm.versions[name]).toContain(version)
  const release = fixture.state().gh.releases.find(entry => entry.tag === tag)
  expect(release?.notes).toBe(extractChangelogEntry(fixture.read(`${dir}/CHANGELOG.md`), version)!)
}

/** Creates a committed, pushed fixture project with pending changesets. */
export function createFixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "changesets-local-test-")))
  const dir = join(root, "work")
  const remote = join(root, "remote.git")
  const stateDir = join(root, "state")
  const binDir = join(root, "bin")
  for (const path of [dir, stateDir, binDir]) {
    mkdirSync(path)
  }
  const initialState = createFakeState()
  if (options.monorepo) {
    for (const name of Object.values(monorepoPackages)) {
      initialState.npm.versions[name] = ["1.0.0"]
    }
  }
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(initialState))
  writeFileSync(join(stateDir, "calls.ndjson"), "")

  for (const tool of realTools) {
    symlinkSync(Bun.which(tool)!, join(binDir, tool))
  }
  for (const tool of ["npm", "pnpm", "gh"] as const) {
    // Not a /bin/sh wrapper: dash drops environment variables such as `npm_config_@scope:registry`.
    writeFileSync(
      join(binDir, tool),
      `#!${Bun.which("bun")} ${join(import.meta.dir, "fake-tool", "main.ts")}\n`,
      { mode: 0o755 },
    )
  }

  const env: NodeJS.ProcessEnv = {
    PATH: binDir,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    FAKE_STATE_DIR: stateDir,
    FAKE_REAL_NPM: Bun.which("npm")!,
    FAKE_REAL_PNPM: Bun.which("pnpm")!,
    FAKE_REAL_PATH: process.env.PATH,
    FAKE_REMOTE: remote,
    // pnpm installs dependencies before running scripts by default, which would replace the linked Changesets.
    pnpm_config_verify_deps_before_run: "false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "tester@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "tester@example.com",
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("MISE_"))),
  }
  const exec = (cwd: string, command: string, ...args: string[]) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`)
    }
    return result.stdout.trim()
  }
  const git = (...args: string[]) => exec(dir, "git", ...args)
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }

  const packageManager = options.packageManager ?? "bun"
  const writeJson = (path: string, value: unknown) =>
    write(path, `${JSON.stringify(value, null, 2)}\n`)
  if (options.monorepo) {
    writeJson("package.json", {
      name: "fixture-root",
      private: true,
      ...(packageManager === "pnpm" ? {} : { workspaces: ["packages/*"] }),
      ...options.packageJson,
    })
    if (packageManager === "pnpm") {
      write("pnpm-workspace.yaml", "packages:\n  - packages/*\n")
    }
    for (const [packageDir, name] of Object.entries(monorepoPackages)) {
      writeJson(`${packageDir}/package.json`, {
        name,
        version: "1.0.0",
        ...options.packages?.[packageDir],
      })
    }
    writeJson(`${privatePackage.dir}/package.json`, {
      name: privatePackage.name,
      version: "1.0.0",
      private: true,
      // npm does not support the workspace protocol and links workspace packages by version range.
      dependencies: { alpha: packageManager === "npm" ? "*" : "workspace:*" },
    })
  } else {
    writeJson("package.json", {
      name: packageName,
      version: "1.0.0",
      dependencies: { dep: "file:./vendor/dep" },
      ...options.packageJson,
    })
    write("vendor/dep/package.json", JSON.stringify({ name: "dep", version: "1.0.0" }))
  }
  // Both ignore pattern styles occur in real projects; only the first one also ignores a node_modules symlink.
  write(".gitignore", options.monorepo ? "node_modules\ndist\n" : "/node_modules/\n/dist/\n")
  writeJson(".changeset/config.json", {
    changelog: "@changesets/cli/changelog",
    commit: false,
    access: "public",
    baseBranch: "main",
    ...options.changesetsConfig,
  })
  const defaultChangesets = options.monorepo
    ? {
        feature: changeset("minor", "Add a feature.", ["alpha"]),
        fix: changeset("patch", "Fix a bug.", ["@fixture/beta"]),
      }
    : { "fix-bug": changeset("patch", "Fix a bug.") }
  for (const [name, content] of Object.entries(options.changesets ?? defaultChangesets)) {
    write(`.changeset/${name}.md`, content)
  }
  // Changesets resolves from the project dependencies; link the one installed in this repository.
  mkdirSync(join(dir, "node_modules", "@changesets"), { recursive: true })
  mkdirSync(join(dir, "node_modules", ".bin"))
  symlinkSync(
    join(repoRoot, "node_modules", "@changesets", "cli"),
    join(dir, "node_modules", "@changesets", "cli"),
  )
  symlinkSync("../@changesets/cli/bin.js", join(dir, "node_modules", ".bin", "changeset"))
  if (options.preTag) {
    exec(dir, join(dir, "node_modules", ".bin", "changeset"), "pre", "enter", options.preTag)
  }

  switch (packageManager) {
    case "npm":
      exec(dir, "npm", "install", "--package-lock-only", "--no-audit", "--no-fund")
      break
    case "pnpm":
      exec(dir, "pnpm", "install", "--lockfile-only")
      break
    case "bun":
      exec(dir, "bun", "install", "--lockfile-only")
      break
  }

  exec(root, "git", "init", "--quiet", "--bare", "--initial-branch=main", remote)
  git("init", "--quiet", "--initial-branch=main")
  git("add", "--all")
  git("commit", "--quiet", "--message", "Initial commit")
  git("remote", "add", "origin", remote)
  git("push", "--quiet", "--set-upstream", "origin", "main")

  const state = () => readFakeState(stateDir)

  return {
    dir,
    remote,
    env,
    async run(releaseOptions = {}, answers = {}) {
      const lines: string[] = []
      const questions: string[] = []
      const controller = new AbortController()
      const ctx: Context = {
        cwd: dir,
        env,
        interactive: false,
        // Long enough that only an abort ends a wait that the test does not let finish.
        pollInterval: answers.abortOnLog ? 60_000 : 0,
        signal: controller.signal,
        // The CLI styles its output when the tests run in a terminal.
        log: line => {
          lines.push(stripVTControlCharacters(line))
          if (answers.abortOnLog && line.includes(answers.abortOnLog)) {
            // After the synchronous code that follows the line, such as starting a wait.
            queueMicrotask(() => controller.abort())
          }
        },
        confirm: async question => {
          questions.push(question)
          if (answers.abort) {
            controller.abort()
            return false
          }
          return answers.confirm ?? true
        },
      }
      try {
        await release(ctx, releaseOptions)
        return { output: lines.join("\n"), questions }
      } catch (error) {
        return { output: lines.join("\n"), questions, error: error as Error }
      }
    },
    git,
    remoteGit: (...args) => exec(remote, "git", ...args),
    read: path => readFileSync(join(dir, path), "utf8"),
    write,
    state,
    updateState: update => updateFakeState(stateDir, update),
    calls: tool =>
      readFileSync(join(stateDir, "calls.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as string[])
        .filter(([name]) => name === tool)
        .map(call => call.slice(1)),
    installHook: (name, script) =>
      writeFileSync(join(dir, ".git", "hooks", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 }),
    removeTool: tool => rmSync(join(binDir, tool)),
    rejectPushes(pattern) {
      const hook = join(remote, "hooks", "pre-receive")
      writeFileSync(
        hook,
        pattern === null
          ? "#!/bin/sh\nexit 0\n"
          : `#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in ${pattern}) echo "rejected $ref" >&2; exit 1;; esac\ndone\n`,
        { mode: 0o755 },
      )
    },
  }
}

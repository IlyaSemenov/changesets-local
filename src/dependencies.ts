import type { Manifest } from "./packages"

/** Manifest fields with dependencies that are installed for users of a package, unlike `devDependencies`. */
export const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/** Returns the given released packages that a manifest depends on at runtime, in their given order. */
export function listReleasedDependencies<T extends { name: string }>(
  manifest: Manifest,
  releases: T[],
) {
  const names = new Set(
    runtimeDependencyFields.flatMap(field => Object.keys(manifest[field] ?? {})),
  )
  return releases.filter(release => names.has(release.name))
}

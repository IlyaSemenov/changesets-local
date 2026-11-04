import type { Manifest } from "./packages"

/** Manifest fields with dependencies that are installed for users of a package, unlike `devDependencies`. */
export const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/** A difference in a runtime dependency between two manifests; a null range means that the field does not have the dependency. */
export interface DependencyRangeChange {
  field: (typeof runtimeDependencyFields)[number]
  dependency: string
  before: string | null
  after: string | null
}

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

/** Lists the differences in runtime dependencies between two manifests, by field and then by dependency name; moving a dependency to another field is a removal and an addition. */
export function diffDependencyRanges(before: Manifest, after: Manifest) {
  return runtimeDependencyFields.flatMap(field => {
    // Maps, since a package may be named like an inherited object property, such as `constructor`.
    const oldRanges = new Map(Object.entries(before[field] ?? {}))
    const newRanges = new Map(Object.entries(after[field] ?? {}))
    const names = new Set([...oldRanges.keys(), ...newRanges.keys()])
    return [...names].toSorted().flatMap((dependency): DependencyRangeChange[] => {
      const oldRange = oldRanges.get(dependency) ?? null
      const newRange = newRanges.get(dependency) ?? null
      return oldRange === newRange ? [] : [{ field, dependency, before: oldRange, after: newRange }]
    })
  })
}

/** Formats a dependency change, such as `peerDependencies core ^1.0.0 → ^2.0.0`. */
export function formatDependencyRangeChange({
  field,
  dependency,
  before,
  after,
}: DependencyRangeChange) {
  const change = before === null ? `added ${after}` : `${before} → ${after ?? "removed"}`
  return `${field} ${dependency} ${change}`
}

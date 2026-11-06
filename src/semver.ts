import { compareCodePoints } from "./strings"

/** Checks whether a version is a prerelease, such as `1.0.0-beta.0`. */
export function isPrerelease(version: string) {
  return version.includes("-")
}

/** Compares two valid SemVer versions by precedence and returns a negative number, zero, or a positive number. */
export function compareVersions(a: string, b: string) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const [index, part] of left.core.entries()) {
    const difference = compareNumbers(part, right.core[index]!)
    if (difference !== 0) {
      return difference
    }
  }
  // A version without a prerelease follows its prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }
  for (const [index, identifier] of left.prerelease.entries()) {
    const other = right.prerelease[index]
    // A shorter prerelease precedes a longer one with the same start.
    if (other === undefined) {
      return 1
    }
    const difference = comparePrereleaseIdentifiers(identifier, other)
    if (difference !== 0) {
      return difference
    }
  }
  return left.prerelease.length - right.prerelease.length
}

/** Splits a version into its core numbers and prerelease identifiers, without build metadata. */
function parseVersion(version: string) {
  const [precedence] = version.split("+") as [string]
  const separator = precedence.indexOf("-")
  const core = separator === -1 ? precedence : precedence.slice(0, separator)
  const prerelease = separator === -1 ? [] : precedence.slice(separator + 1).split(".")
  return { core: core.split("."), prerelease }
}

/** Compares prerelease identifiers: numbers numerically, before any text, and text in code point order. */
function comparePrereleaseIdentifiers(a: string, b: string) {
  const isNumber = /^\d+$/
  if (isNumber.test(a) && isNumber.test(b)) {
    return compareNumbers(a, b)
  }
  if (isNumber.test(a) !== isNumber.test(b)) {
    return isNumber.test(a) ? -1 : 1
  }
  return compareCodePoints(a, b)
}

/**
 * Compares decimal numbers of any size.
 *
 * SemVer numbers have no leading zeros, so a longer number is higher; `Number` would round large ones.
 */
function compareNumbers(a: string, b: string) {
  return a.length - b.length || compareCodePoints(a, b)
}

/** Compares strings in code point order. */
export function compareCodePoints(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

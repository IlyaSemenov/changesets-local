/**
 * Extracts the notes of a version from a changelog in the Changesets format.
 *
 * The notes are the content between the heading whose text is the version, such as `## 1.2.0`, and the next heading of the same or higher level.
 * Headings inside fenced code blocks are ignored.
 * Returns undefined when the changelog has no heading for the version.
 */
export function extractChangelogEntry(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n")
  let fence: string | undefined
  let start: number | undefined
  let depth = 0
  let end = lines.length
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMatch) {
      const [, marker, rest] = fenceMatch as unknown as [string, string, string]
      if (fence === undefined) {
        fence = marker
        continue
      }
      // A closing fence repeats the opening character at least as many times and has no info string.
      if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") {
        fence = undefined
        continue
      }
    }
    if (fence !== undefined) {
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (!heading) {
      continue
    }
    const level = heading[1]!.length
    if (start === undefined) {
      if (heading[2] === version) {
        start = index + 1
        depth = level
      }
    } else if (level <= depth) {
      end = index
      break
    }
  }
  return start === undefined ? undefined : lines.slice(start, end).join("\n").trim()
}

import { readFile } from "node:fs/promises"

import { ReleaseError } from "./context"

/**
 * Reads and parses a JSON file.
 *
 * Returns undefined when the file does not exist and fails with a ReleaseError when it is not valid JSON.
 * The result is not validated against `T`.
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined
    }
    throw error
  }
  return parseJsonContent<T>(content, path)
}

/**
 * Parses JSON content and uses `path` in error messages.
 *
 * Returns undefined for null content, which stands for a missing file, and fails with a ReleaseError when it is not valid JSON.
 * The result is not validated against `T`.
 */
export function parseJsonContent<T>(content: string | null, path: string): T | undefined {
  if (content === null) {
    return undefined
  }
  try {
    return JSON.parse(content) as T
  } catch (error) {
    throw new ReleaseError(`Cannot parse ${path}: ${(error as Error).message}`)
  }
}

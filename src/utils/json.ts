export function parseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.flatMap((item) =>
      String(item)
        .replace(/\\r\\n|\\n|\\r/g, '\n')
        .split(/\r\n|\n|\r/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )
  } catch {
    return []
  }
}

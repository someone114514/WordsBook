export function parseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.map((item) => String(item))
  } catch {
    return []
  }
}

const stripOuterQuotes = (value: string) => {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1)
  }

  return value
}

export function toAstIdentifier(identifier: string): string {
  const raw = stripOuterQuotes(identifier.trim())
  const escaped = raw.replace(/"/g, '""')
  return `"${escaped}"`
}

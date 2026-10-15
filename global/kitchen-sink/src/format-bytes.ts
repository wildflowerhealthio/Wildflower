/**
 * Human-readable byte size using binary (1024) units — `512 B`, `1.5 KB`,
 * `5.0 MB`. Values that read under 10 in their unit at one decimal place keep
 * that decimal; larger values round to a whole number; raw bytes (under 1 KB)
 * are always whole.
 *
 * Pure and locale-independent — a compact size label for file/storage UIs.
 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  // Promote on the *rounded* value, not the raw one: 1023.75 KB rounds to
  // "1024", which must read as "1.0 MB" rather than "1024 KB". `Math.round`
  // here mirrors the whole-number rendering below (the < 10 branch can never
  // reach 1024, so it needs no guard).
  while (unit < units.length - 1 && Math.round(value) >= 1024) {
    value /= 1024
    unit += 1
  }
  // Pick the decimal on the value as it would print: 9.96 KB prints as "10.0"
  // at one decimal, which is already in the whole-number range and reads "10".
  const oneDecimal = value.toFixed(1)
  const rendered = Number(oneDecimal) < 10 ? oneDecimal : String(Math.round(value))
  return `${rendered} ${units[unit]}`
}

export { formatBytes }

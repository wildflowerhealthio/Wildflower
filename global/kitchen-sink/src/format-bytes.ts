/**
 * Human-readable byte size using binary (1024) units — `512 B`, `1.5 KB`,
 * `5.0 MB`. Values under 10 in their unit keep one decimal place; larger values
 * round to a whole number; raw bytes (under 1 KB) are always whole.
 *
 * Pure and locale-independent — a compact size label for file/storage UIs.
 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value))
  return `${rounded} ${units[unit]}`
}

export { formatBytes }

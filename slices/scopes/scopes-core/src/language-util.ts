/** Join parts as a sentence list: `"A"`, `"A and B"`, `"A, B and C"`; empty for none. */
export const sentenceJoin = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts.join('')
  const last = parts.at(-1) ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${last}`
}

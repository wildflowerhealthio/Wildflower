/**
 * Join parts into an English sentence list via `Intl.ListFormat` — `"a"`,
 * `"a and b"`, `"a, b, and c"` (long conjunction style, Oxford comma).
 *
 * English-only by design (the formatter is fixed to `en`) — a label helper for
 * UIs whose copy is English, not a localization seam.
 */
const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

const sentenceJoin = (parts: readonly string[]): string => formatter.format(parts)

export { sentenceJoin }

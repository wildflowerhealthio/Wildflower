/**
 * Strip HTML tags, trademark marks and diacritics, and lower-case. The first
 * step toward a canonical form both sponsored-drug names and medication names
 * are reduced to before comparison.
 *
 * Marks are removed *before* NFKD normalization: NFKD expands the trademark
 * sign into the letters `TM`, so stripping after normalizing would leave
 * spurious `tm` tokens behind.
 */
const stripMarkup = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u00ae\u2122\u00a9]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** Standalone dosage-unit tokens dropped as matching noise. */
const unitTokens = new Set(['mg', 'mcg', 'g', 'ml', 'l', 'units', 'unit', 'iu', 'kg', 'mm', 'meq'])

/** A bare number (`"35"`) or a number glued to a unit (`"35mg"`) -- also noise. */
const numericToken = /^\d+$/
const gluedStrengthToken = /^\d+(?:mg|mcg|g|ml|l|units?|iu|kg|mm|meq)$/

/** Whether a token is dosage / strength noise rather than part of the name. */
const isNoiseToken = (token: string): boolean =>
  numericToken.test(token) || gluedStrengthToken.test(token) || unitTokens.has(token)

/**
 * Reduce a drug or medication name to a canonical token string for matching:
 * markup and marks removed, split into alphanumeric tokens, dosage / strength
 * tokens dropped, re-joined with single spaces.
 *
 * Token filtering (rather than regex substitution over the raw string) makes
 * the transform idempotent -- `normalizeName(normalizeName(x))` equals
 * `normalizeName(x)` -- because the output holds only kept tokens, so a second
 * pass drops nothing. The property tests pin this.
 */
const normalizeName = (value: string): string =>
  stripMarkup(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !isNoiseToken(token))
    .join(' ')

/** Split a name into its normalized tokens (empty input → no tokens). */
const tokenize = (value: string): readonly string[] => {
  const normalized = normalizeName(value)
  return normalized.length === 0 ? [] : normalized.split(' ')
}

export { normalizeName, tokenize }

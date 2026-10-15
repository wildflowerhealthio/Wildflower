/**
 * The match key of one code point: compatibility-decomposed (NFKD), combining
 * marks dropped, then case-folded by an upper-then-lower round trip. So `é`,
 * `e` + U+0301 and `E` share the key `e`; `İ` (U+0130) and `ı` key as `i`;
 * `ſ` keys as `s`; `ς` and `Σ` key as `σ`; `ﬁ` keys as `fi`; a lone combining
 * mark keys as the empty string.
 *
 * Keyed one code point at a time, never over a whole string: whole-string case
 * mapping is context-sensitive (final sigma), and per-code-point keys are what
 * let a match in the key be mapped back to the code points that produced it.
 */
const codePointKey = (ch: string): string =>
  ch.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().toLowerCase()

// Keying runs per code point, per run, per rule, on every edit of a rule — so
// remember each code point's key. Bounded by the distinct code points seen.
const codePointKeys = new Map<string, string>()

const cachedCodePointKey = (ch: string): string => {
  const cached = codePointKeys.get(ch)
  if (cached !== undefined) return cached
  const key = codePointKey(ch)
  codePointKeys.set(ch, key)
  return key
}

/**
 * The form two texts are compared in when matching a substitution rule: a rule
 * masks a run wherever the rule's key occurs in the run's key. Insensitive to
 * case, accents, Unicode normalization form and compatibility variants
 * (full-width, ligatures, circled letters) — a redaction tool should over-match
 * a name rather than miss a spelling of it.
 */
const matchKey = (text: string): string => Array.from(text, cachedCodePointKey).join('')

/**
 * A text's {@link matchKey} plus, for each UTF-16 unit of the key, the span of
 * `text` that produced it. A code point whose key is empty (a combining mark)
 * extends the span of the code point before it, so masking a matched base
 * letter also masks the marks on it.
 */
interface KeyedText {
  readonly key: string
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}

const keyedText = (text: string): KeyedText => {
  let key = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const ch of text) {
    const piece = cachedCodePointKey(ch)
    const next = offset + ch.length
    if (piece === '') {
      for (let i = ends.length - 1; i >= 0 && ends[i] === offset; i -= 1) ends[i] = next
    }
    for (let i = 0; i < piece.length; i += 1) {
      starts.push(offset)
      ends.push(next)
    }
    key += piece
    offset = next
  }
  return { key, starts, ends }
}

export { keyedText, matchKey, type KeyedText }

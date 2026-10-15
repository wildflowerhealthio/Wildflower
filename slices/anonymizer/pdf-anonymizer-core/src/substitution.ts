import { Match } from 'effect'

import { Document } from '@wildflowerhealthio/positioned-text'

import { keyedText, matchKey } from './match-key.ts'

/**
 * One user-entered literal substring to mask in the extracted text.
 */
interface SubstitutionRule {
  readonly id: string
  readonly text: string
}

const isKept = (ch: string): boolean => /^[\s\p{P}]$/u.test(ch)
const isUpperLetter = (ch: string): boolean => /^[\p{Lu}\p{Lt}]$/u.test(ch)
const isDigit = (ch: string): boolean => /^\p{N}$/u.test(ch)

/**
 * Class-preserving same-length mask over an allowlist: whitespace and
 * punctuation are kept verbatim; uppercase and titlecase letters → X, digits →
 * 0, and every other code point → x — lowercase letters, caseless scripts (CJK,
 * Arabic, Hebrew), combining marks (Devanagari vowel signs, Thai tone marks,
 * niqqud), symbols (circled letters, emoji). Preserves the code-point count.
 * Idempotent by construction (X → X, x → x, 0 → 0). Unicode-aware via `\p{}`
 * categories.
 */
const maskChar = Match.type<string>().pipe(
  Match.when(isKept, (ch) => ch),
  Match.when(isUpperLetter, () => 'X'),
  Match.when(isDigit, () => '0'),
  Match.orElse(() => 'x')
)

const maskSameLength = (input: string): string => Array.from(input, maskChar).join('')

interface RuleMatch {
  readonly ruleId: string
  readonly count: number
}

interface SubstitutionResult {
  readonly document: Document.Type
  readonly ruleMatches: readonly RuleMatch[]
}

/**
 * Mask each occurrence of `needleKey` (a rule's {@link matchKey}) inside
 * `text`, leaving the rest of `text` untouched, and count the occurrences
 * masked. The occurrences are found in `text`'s match key and mapped back to
 * the code points of `text` that produced them, so the mask lands on the
 * original characters (and the marks on them) even where the key differs in
 * length from the text (`İ`, `ﬁ`, decomposed accents).
 */
const maskAllInstances = (
  text: string,
  needleKey: string
): { readonly masked: string; readonly count: number } => {
  if (!matchKey(text).includes(needleKey)) return { masked: text, count: 0 }
  const { key, starts, ends } = keyedText(text)
  let count = 0
  let masked = ''
  let cursor = 0
  for (
    let at = key.indexOf(needleKey);
    at !== -1;
    at = key.indexOf(needleKey, at + needleKey.length)
  ) {
    count += 1
    // Two occurrences can share a code point (`f` twice in `ﬀ`); mask it once.
    const from = Math.max(starts[at] ?? cursor, cursor)
    const to = ends[at + needleKey.length - 1] ?? cursor
    masked += text.slice(cursor, from) + maskSameLength(text.slice(from, to))
    cursor = Math.max(cursor, to)
  }
  return { masked: masked + text.slice(cursor), count }
}

/**
 * Apply substitution rules to a positioned-text document: literal matching by
 * {@link matchKey} (insensitive to case, accents and normalization form),
 * global, within-run only. Rules are applied in order over the previous result
 * so earlier rules' masks are visible to later rules.
 */
const applySubstitutions = (
  doc: Document.Type,
  rules: readonly SubstitutionRule[]
): SubstitutionResult =>
  rules.reduce<SubstitutionResult>(
    (acc, rule) => {
      const needleKey = matchKey(rule.text)
      // An empty key (an empty rule, or one of only combining marks) matches at
      // every position — guard it out and record a zero count rather than one
      // match per position.
      if (needleKey === '') {
        return { ...acc, ruleMatches: [...acc.ruleMatches, { ruleId: rule.id, count: 0 }] }
      }
      let count = 0
      const document = Document.mapText(acc.document, (text) => {
        const replaced = maskAllInstances(text, needleKey)
        count += replaced.count
        return replaced.masked
      })
      return { document, ruleMatches: [...acc.ruleMatches, { ruleId: rule.id, count }] }
    },
    { document: doc, ruleMatches: [] }
  )

export {
  applySubstitutions,
  maskSameLength,
  type RuleMatch,
  type SubstitutionResult,
  type SubstitutionRule,
}

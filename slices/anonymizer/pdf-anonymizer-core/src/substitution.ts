import { RegExp as EffectRegExp, Match } from 'effect'

import { Document } from '@wildflowerhealthio/positioned-text'

/**
 * One user-entered literal substring to mask in the extracted text.
 */
interface SubstitutionRule {
  readonly id: string
  readonly text: string
}

const isUpperLetter = (ch: string): boolean => /^[\p{Lu}\p{Lt}]$/u.test(ch)
const isOtherLetter = (ch: string): boolean => /^\p{L}$/u.test(ch)
const isDigit = (ch: string): boolean => /^\p{N}$/u.test(ch)

/**
 * Class-preserving same-length mask: uppercase and titlecase → X, every other
 * letter (lowercase, and caseless scripts such as CJK, Arabic, Hebrew) → x,
 * digit → 0, everything else (punctuation, whitespace, marks, symbols) kept
 * verbatim. Idempotent by construction (X → X, x → x, 0 → 0). Unicode-aware
 * via `\p{}` categories.
 */
const maskChar = Match.type<string>().pipe(
  Match.when(isUpperLetter, () => 'X'),
  Match.when(isOtherLetter, () => 'x'),
  Match.when(isDigit, () => '0'),
  Match.orElse((ch) => ch)
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
 * Mask each case-insensitive occurrence of `needle` inside `text`, leaving the
 * rest of `text` untouched, and count the occurrences masked. The match is
 * found in `text` itself (a `u`-flag regex, simple case folding), never on a
 * lowercased copy: `toLowerCase` can change a string's length (`İ` → `i̇`), so
 * offsets found in a lowercased copy would mask the wrong characters of the
 * original.
 */
const maskAllInstancesCaseInsensitive = (
  text: string,
  needle: string
): { readonly masked: string; readonly count: number } => {
  let count = 0
  const masked = text.replace(new RegExp(EffectRegExp.escape(needle), 'giu'), (match) => {
    count += 1
    return maskSameLength(match)
  })
  return { masked, count }
}

/**
 * Apply substitution rules to a positioned-text document: case-insensitive
 * literal matching, global, within-run only. Rules are applied in order over the
 * previous result so earlier rules' masks are visible to later rules.
 */
const applySubstitutions = (
  doc: Document.Type,
  rules: readonly SubstitutionRule[]
): SubstitutionResult =>
  rules.reduce<SubstitutionResult>(
    (acc, rule) => {
      // An empty needle matches at every position — guard it out and record a
      // zero count rather than one match per position.
      if (rule.text === '') {
        return { ...acc, ruleMatches: [...acc.ruleMatches, { ruleId: rule.id, count: 0 }] }
      }
      let count = 0
      const document = Document.mapText(acc.document, (text) => {
        const replaced = maskAllInstancesCaseInsensitive(text, rule.text)
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

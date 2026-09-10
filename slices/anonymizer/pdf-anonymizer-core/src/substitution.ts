import { Match } from 'effect'

import { Document } from 'positioned-text'

/**
 * One user-entered literal substring to mask in the extracted text.
 */
interface SubstitutionRule {
  readonly id: string
  readonly text: string
}

const isUpperLetter = (ch: string): boolean => /^\p{Lu}$/u.test(ch)
const isLowerLetter = (ch: string): boolean => /^\p{Ll}$/u.test(ch)
const isDigit = (ch: string): boolean => /^\p{N}$/u.test(ch)

/**
 * Class-preserving same-length mask: uppercase → X, lowercase → x, digit → 0,
 * everything else (punctuation, whitespace) kept verbatim. Idempotent by
 * construction (X → X, x → x, 0 → 0). Unicode-aware via `\p{}` categories.
 */
const maskChar = Match.type<string>().pipe(
  Match.when(isUpperLetter, () => 'X'),
  Match.when(isLowerLetter, () => 'x'),
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

const replaceAllCaseInsensitive = (
  text: string,
  needle: string
): { readonly result: string; readonly count: number } => {
  const needleLower = needle.toLowerCase()
  let result = ''
  let searchFrom = 0
  let count = 0

  const textLower = text.toLowerCase()

  while (searchFrom <= text.length - needleLower.length) {
    const foundAt = textLower.indexOf(needleLower, searchFrom)
    if (foundAt === -1) break
    result += text.slice(searchFrom, foundAt)
    result += maskSameLength(text.slice(foundAt, foundAt + needleLower.length))
    count += 1
    searchFrom = foundAt + needleLower.length
  }

  result += text.slice(searchFrom)
  return { result, count }
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
      // An empty needle matches at every position — guard it out (it would loop
      // forever in replaceAllCaseInsensitive) and record a zero count.
      if (rule.text === '') {
        return { ...acc, ruleMatches: [...acc.ruleMatches, { ruleId: rule.id, count: 0 }] }
      }
      let count = 0
      const document = Document.mapText(acc.document, (text) => {
        const replaced = replaceAllCaseInsensitive(text, rule.text)
        count += replaced.count
        return replaced.result
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

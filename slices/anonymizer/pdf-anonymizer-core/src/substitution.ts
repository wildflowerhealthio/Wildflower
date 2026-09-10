import { Match, Predicate, pipe } from 'effect'

import type { PositionedTextDocument } from 'positioned-text'

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
  readonly document: PositionedTextDocument
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
  doc: PositionedTextDocument,
  rules: readonly SubstitutionRule[]
): SubstitutionResult => {
  const activeRules = rules.filter((r) => r.text !== '')
  const emptyMatches = rules.map((rule): RuleMatch => ({ ruleId: rule.id, count: 0 }))

  if (activeRules.length === 0) return { document: doc, ruleMatches: emptyMatches }

  const { pages: resultPages, matches: activeMatches } = pipe(activeRules, (active) =>
    active.reduce(
      (acc, rule) => {
        let totalCount = 0
        const nextPages = acc.pages.map((page) => ({
          ...page,
          runs: page.runs.map((run) => {
            if (Predicate.isNullable(run.text) || run.text === '') return run
            const { result, count } = replaceAllCaseInsensitive(run.text, rule.text)
            totalCount += count
            return count > 0 ? { ...run, text: result } : run
          }),
        }))
        return {
          pages: nextPages,
          matches: [...acc.matches, { ruleId: rule.id, count: totalCount }],
        }
      },
      { pages: doc.pages, matches: [] as RuleMatch[] }
    )
  )

  const ruleMatchMap = new Map(activeMatches.map((m) => [m.ruleId, m.count]))

  return {
    document: { ...doc, pages: resultPages },
    ruleMatches: rules.map((rule): RuleMatch => ({
      ruleId: rule.id,
      count: ruleMatchMap.get(rule.id) ?? 0,
    })),
  }
}

export {
  applySubstitutions,
  maskSameLength,
  type RuleMatch,
  type SubstitutionResult,
  type SubstitutionRule,
}

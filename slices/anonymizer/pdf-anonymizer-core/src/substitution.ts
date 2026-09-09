import type { PositionedTextDocument } from './positioned-text.ts'

/**
 * One user-entered literal substring to mask in the extracted text.
 */
interface SubstitutionRule {
  readonly id: string
  readonly text: string
}

/**
 * Class-preserving same-length mask: uppercase → X, lowercase → x, digit → 0,
 * everything else (punctuation, whitespace) kept verbatim. Idempotent by
 * construction (X → X, x → x, 0 → 0).
 */
const maskSameLength = (input: string): string => {
  let result = ''
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    const code = ch.codePointAt(0)!
    if (code >= 0x41 && code <= 0x5a) result += 'X'
    else if (code >= 0x61 && code <= 0x7a) result += 'x'
    else if (code >= 0x30 && code <= 0x39) result += '0'
    else result += ch
  }
  return result
}

interface RuleMatch {
  readonly ruleId: string
  readonly count: number
}

interface SubstitutionResult {
  readonly document: PositionedTextDocument
  readonly ruleMatches: readonly RuleMatch[]
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
  const ruleMatches: RuleMatch[] = rules.map((rule) => ({ ruleId: rule.id, count: 0 }))

  let currentPages = doc.pages

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex]
    if (rule.text === '') continue

    const needle = rule.text.toLowerCase()
    let totalCount = 0

    const nextPages = currentPages.map((page) => ({
      ...page,
      runs: page.runs.map((run) => {
        const textLower = run.text.toLowerCase()
        let result = ''
        let searchFrom = 0
        let matchCount = 0

        while (searchFrom <= run.text.length - needle.length) {
          const foundAt = textLower.indexOf(needle, searchFrom)
          if (foundAt === -1) break
          result += run.text.slice(searchFrom, foundAt)
          result += maskSameLength(run.text.slice(foundAt, foundAt + needle.length))
          matchCount += 1
          searchFrom = foundAt + needle.length
        }

        if (matchCount === 0) return run

        result += run.text.slice(searchFrom)
        totalCount += matchCount
        return { ...run, text: result }
      }),
    }))

    ruleMatches[ruleIndex] = { ruleId: rule.id, count: totalCount }
    currentPages = nextPages
  }

  return {
    document: { ...doc, pages: currentPages },
    ruleMatches,
  }
}

export {
  applySubstitutions,
  maskSameLength,
  type RuleMatch,
  type SubstitutionResult,
  type SubstitutionRule,
}

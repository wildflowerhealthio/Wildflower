import type { PositionedTextDocument } from './positioned-text.ts'

interface FrequentSubstring {
  readonly text: string
  readonly count: number
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'no',
  'nor',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'too',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
])

const MIN_WORD_LENGTH = 3
const MIN_COUNT = 2
const MAX_SUGGESTIONS = 50

const splitWords = (text: string): readonly string[] =>
  text.split(/\s+/).filter((w) => w.length > 0)

/**
 * Extract frequently occurring substrings from a positioned-text document.
 * Builds word n-grams (1–3 words) from each run, counts them
 * case-insensitively (keeping the casing of the first occurrence), filters
 * out stopwords and low-frequency entries, and returns the top results sorted
 * by frequency descending, then by text length descending.
 */
const extractFrequentSubstrings = (doc: PositionedTextDocument): readonly FrequentSubstring[] => {
  const counts = new Map<string, number>()
  const canonical = new Map<string, string>()

  for (const page of doc.pages) {
    for (const run of page.runs) {
      const words = splitWords(run.text)

      for (let n = 1; n <= 3; n += 1) {
        for (let i = 0; i <= words.length - n; i += 1) {
          const phrase = words.slice(i, i + n).join(' ')
          const key = phrase.toLowerCase()

          if (n === 1) {
            if (phrase.length < MIN_WORD_LENGTH) continue
            if (STOPWORDS.has(key)) continue
          }

          counts.set(key, (counts.get(key) ?? 0) + 1)
          if (!canonical.has(key)) canonical.set(key, phrase)
        }
      }
    }
  }

  const results: FrequentSubstring[] = []

  for (const [key, count] of counts) {
    if (count < MIN_COUNT) continue
    results.push({ text: canonical.get(key)!, count })
  }

  results.sort((a, b) => b.count - a.count || b.text.length - a.text.length)

  return results.slice(0, MAX_SUGGESTIONS)
}

export { extractFrequentSubstrings, type FrequentSubstring }

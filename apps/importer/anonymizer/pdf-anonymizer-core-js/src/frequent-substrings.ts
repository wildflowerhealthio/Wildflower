import { Array as Arr, Order, pipe } from 'effect'
import { Document } from 'positioned-text'

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
const MAX_NGRAM = 3

/** One word n-gram: its word length `n` and the phrase's original casing. */
interface Ngram {
  readonly n: number
  readonly phrase: string
}

const splitWords = (text: string): readonly string[] =>
  text.split(/\s+/).filter((w) => w.length > 0)

/** Word n-grams of length 1..{@link MAX_NGRAM}, left to right. */
const ngramsOf = (words: readonly string[]): readonly Ngram[] =>
  pipe(
    Arr.range(1, MAX_NGRAM),
    Arr.flatMap((n) =>
      pipe(
        Arr.dropRight(words, n - 1),
        Arr.map((_, start) => ({ n, phrase: words.slice(start, start + n).join(' ') }))
      )
    )
  )

/** A unigram must clear the length and stopword filters; longer grams pass. */
const isCandidate = ({ n, phrase }: Ngram): boolean =>
  n > 1 || (phrase.length >= MIN_WORD_LENGTH && !STOPWORDS.has(phrase.toLowerCase()))

const descendingBy = <A>(f: (a: A) => number): Order.Order<A> =>
  Order.mapInput(Order.reverse(Order.number), f)

/** Most frequent first, then longest — the order suggestions are surfaced in. */
const byFrequencyThenLength: readonly Order.Order<FrequentSubstring>[] = [
  descendingBy((s) => s.count),
  descendingBy((s) => s.text.length),
]

/**
 * Extract frequently occurring substrings from a positioned-text document.
 * Builds word n-grams (1–3 words) from each run, counts them
 * case-insensitively (keeping the casing of the first occurrence), filters
 * out stopwords and low-frequency entries, and returns the top results sorted
 * by frequency descending, then by text length descending.
 */
const extractFrequentSubstrings = (doc: Document.Type): readonly FrequentSubstring[] => {
  // Tally into a Map (not `Array.groupBy`'s Record): a plain object reorders
  // integer-like keys such as "2024", which would scramble the first-occurrence
  // casing and the stable-sort tie-break below.
  const tally = pipe(
    Document.runs(doc),
    Arr.flatMap((run) => ngramsOf(splitWords(run.text))),
    Arr.filter(isCandidate),
    Arr.reduce(new Map<string, FrequentSubstring>(), (acc, { phrase }) => {
      const key = phrase.toLowerCase()
      const seen = acc.get(key)
      return acc.set(
        key,
        seen ? { text: seen.text, count: seen.count + 1 } : { text: phrase, count: 1 }
      )
    })
  )

  return pipe(
    Arr.fromIterable(tally.values()),
    Arr.filter((s) => s.count >= MIN_COUNT),
    Arr.sortBy(...byFrequencyThenLength),
    Arr.take(MAX_SUGGESTIONS)
  )
}

export { extractFrequentSubstrings, type FrequentSubstring }

import { Array as Arr, Option, String as Str } from 'effect'

import type { Displayable } from './human-name-display.ts'

/*
 * A name's family name and given names read out of how it is written, apart
 * from the `HumanName` schema as `human-name-display.ts` is: the words keep
 * their casing and diacritics, so the parts can be written on a resource, and
 * a reader comparing names normalises them itself. `HumanName.partsOf`
 * re-exports it.
 */

/**
 * A name's family name and given names, each word as written: the family
 * name's words single-spaced, and each given name one word.
 */
interface Parts {
  readonly family: string
  readonly given: readonly string[]
}

/** The words a doctor's title is written as, compared as {@link keyOf} reads a word. */
const DOCTOR_TITLES: ReadonlySet<string> = new Set(['dr', 'doctor'])

/**
 * The words a credential is written as after a name ("John Smith, MD"),
 * compared as {@link keyOf} reads a word. Credentials that are also names
 * ("Do", "Pa", "Od") are left out, so "Nguyen, Do" keeps its given name.
 */
const CREDENTIALS: ReadonlySet<string> = new Set([
  'md',
  'np',
  'rn',
  'rph',
  'pharmd',
  'phd',
  'dds',
  'dmd',
])

/**
 * The generational suffixes written after a name ("John Smith Jr",
 * "Schmitt, John, Jr"), compared as {@link keyOf} reads a word.
 */
const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])

/** `word` as the title, credential and suffix sets hold it: lower-cased, without diacritics or dots. */
const keyOf = (word: string): string =>
  word.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase().replaceAll('.', '')

/** Whether `word` is a doctor's title ({@link DOCTOR_TITLES}). */
const isDoctorTitle = (word: string): boolean => DOCTOR_TITLES.has(keyOf(word))

/** Whether `word` is a generational suffix ({@link GENERATIONAL_SUFFIXES}). */
const isGenerationalSuffix = (word: string): boolean => GENERATIONAL_SUFFIXES.has(keyOf(word))

/**
 * Whether `word` is written around a name rather than in it: a doctor's
 * title, a credential ({@link CREDENTIALS}) or a generational suffix.
 */
const isTitleCredentialOrSuffix = (word: string): boolean =>
  isDoctorTitle(word) || CREDENTIALS.has(keyOf(word)) || isGenerationalSuffix(word)

/** The whitespace-separated words of `namePart`, as written. */
const wordsOf = (namePart: string): readonly string[] =>
  namePart.split(/\s+/u).filter(Str.isNonEmpty)

/** `words` without the doctor's titles leading them. */
const withoutLeadingTitles = (words: readonly string[]): readonly string[] =>
  Arr.dropWhile(words, isDoctorTitle)

/** `words` without the generational suffixes trailing them; a first word is always kept. */
const withoutTrailingSuffixes = (words: readonly string[]): readonly string[] =>
  words.length > 1 && isGenerationalSuffix(words.at(-1) ?? '')
    ? withoutTrailingSuffixes(words.slice(0, -1))
    : words

/**
 * Whether `words` are a tail a name can drop: at least one word, every one
 * of them a credential or a generational suffix.
 */
const isDroppableTail = (words: readonly string[]): boolean =>
  Arr.isNonEmptyReadonlyArray(words) &&
  words.every((word) => CREDENTIALS.has(keyOf(word)) || isGenerationalSuffix(word))

/**
 * `familyWords` and `givenWords` as a name's parts, the doctor's titles
 * leading either dropped; `None` when no family name is left.
 */
const partsFrom = (
  familyWords: readonly string[],
  givenWords: readonly string[]
): Option.Option<Parts> => {
  const family = withoutLeadingTitles(familyWords).join(' ')
  return Option.liftPredicate({ family, given: withoutLeadingTitles(givenWords) }, () =>
    Str.isNonEmpty(family)
  )
}

/**
 * The comma-separated parts of `text` as words, without an empty part ("John
 * Smith,") and without the credentials and generational suffixes that trail
 * them after a comma ("John Smith, MD", "John Smith, MD, PhD", "Smith, John,
 * RPh", "Schmitt, John, Jr"); a first part is always kept.
 */
const partsWithoutDroppableTail = (text: string): readonly (readonly string[])[] => {
  const withoutTail = (parts: readonly (readonly string[])[]): readonly (readonly string[])[] =>
    parts.length > 1 && isDroppableTail(parts.at(-1) ?? [])
      ? withoutTail(parts.slice(0, -1))
      : parts
  return withoutTail(text.split(',').map(wordsOf).filter(Arr.isNonEmptyReadonlyArray))
}

/**
 * `words`, read without commas, as a name's parts: the family name the words
 * before the first doctor's title ("OSEI DR. KWAME"), and the given names the
 * words after it, none when it ends the words ("OSEI DR."); with no title,
 * given names then a family name, the last word ("John Smith").
 */
const partsOfWords = (words: readonly string[]): Option.Option<Parts> => {
  const [beforeTitle, fromTitle] = Arr.span(words, (word) => !isDoctorTitle(word))
  return Arr.match(fromTitle, {
    onEmpty: () => Option.map(Arr.last(words), (family) => ({ family, given: words.slice(0, -1) })),
    onNonEmpty: (titleOnwards) => partsFrom(beforeTitle, Arr.tailNonEmpty(titleOnwards)),
  })
}

/**
 * The family name and given names `text` is written as, each word as
 * written; `None` when no family name is left.
 *
 * @remarks
 * A doctor's title, a credential or a generational suffix is recognised
 * whatever its case and dots ("Dr", "DR.", "M.D.") and dropped, not moved
 * to `prefix` or `suffix`. The reading runs in three steps:
 *
 * 1. Credentials and generational suffixes trailing the text after a comma
 *    are dropped ("John Smith, MD", "Schmitt, John, Jr"), as is an empty
 *    part ("John Smith,").
 * 2. When exactly one comma is left, the family name is written first
 *    ("Schmitt, John Jacob"): the comma, not a title, ends it, and the titles
 *    leading either side are dropped ("Brown, Dr. Jonathan"), as are the
 *    generational suffixes trailing the given names ("Schmitt, John Jr").
 * 3. Otherwise any other commas read as spaces, the titles leading the words
 *    and the generational suffixes trailing them are dropped ("Dr. John Smith
 *    Jr"), and the first title left among them splits the name: family name
 *    before it, given names after it ("OSEI DR. KWAME"), none when it ends
 *    the words ("OSEI DR."). With no title left the last word is the family
 *    name and the words before it the given names.
 */
const partsOfText = (text: string): Option.Option<Parts> => {
  const parts = partsWithoutDroppableTail(text)
  if (parts.length === 2) {
    return partsFrom(parts[0] ?? [], withoutTrailingSuffixes(parts[1] ?? []))
  }
  return partsOfWords(withoutTrailingSuffixes(withoutLeadingTitles(parts.flat())))
}

/**
 * The family name and given names of `name`: its `family` and `given` when
 * it states either, the doctor's titles leading each dropped, else its `text`
 * ({@link partsOfText}); `None` when no family name is left. `prefix` and
 * `suffix` are not read.
 */
const partsOf = (name: Pick<Displayable, 'family' | 'given' | 'text'>): Option.Option<Parts> =>
  (name.family ?? null) !== null || (name.given ?? []).length > 0
    ? partsFrom(wordsOf(name.family ?? ''), (name.given ?? []).flatMap(wordsOf))
    : partsOfText(name.text ?? '')

export { isTitleCredentialOrSuffix, partsOf, partsOfText }
export type { Parts }

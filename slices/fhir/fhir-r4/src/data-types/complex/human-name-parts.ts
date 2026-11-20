import { Array as Arr, Option, String as Str } from 'effect'

import type { Displayable } from './human-name-display.ts'

/*
 * A name's family name and given names read out of how it is written, apart
 * from the `HumanName` schema as `human-name-display.ts` is: the words keep
 * their casing and diacritics, so the parts can be written on a resource, and
 * a reader comparing names folds them itself, a word at a time
 * (`comparableWordOf`). `HumanName.partsOf` re-exports it.
 */

/**
 * A name's parts, each word as written: the family name's words
 * single-spaced, each given name one word, and the words written around the
 * name rather than in it, in the order written: the doctor's titles in
 * `prefix`, the credentials and generational suffixes in `suffix`.
 */
interface Parts {
  readonly family: string
  readonly given: readonly string[]
  readonly prefix: readonly string[]
  readonly suffix: readonly string[]
}

/**
 * The words a doctor's title is written as, compared as
 * {@link comparableWordOf} reads a word, without the dots ending it.
 */
const DOCTOR_TITLES: ReadonlySet<string> = new Set(['dr', 'doctor'])

/**
 * The words a credential is written as after a name ("John Smith, MD",
 * "John Smith MD"), compared as {@link comparableWordOf} reads a word, without
 * its dots. Credentials that are also names ("Do", "Pa", "Od") are left out,
 * so "Nguyen, Do" keeps its given name.
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
 * "Schmitt, John, Jr"), compared as {@link comparableWordOf} reads a word,
 * without its dots.
 */
const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])

/** `word` as two words are compared: lower-cased and without diacritics (decomposed, combining marks dropped). */
const comparableWordOf = (word: string): string =>
  word.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase()

/**
 * What a written word is to a name: a doctor's `title`, with or without the
 * dots ending it ("Dr", "DR.", but not the initials "D.R."); a `credential`
 * or a generational `suffix`, whatever its dots ("M.D.", "Jr."); else a word
 * of the `name` itself.
 */
type WordRole = 'title' | 'credential' | 'suffix' | 'name'

/** A written word and its role ({@link roleOf}), read once. */
interface Word {
  readonly written: string
  readonly role: WordRole
}

/** The role of `word` ({@link WordRole}), folding it once. */
const roleOf = (word: string): WordRole => {
  const folded = comparableWordOf(word)
  if (DOCTOR_TITLES.has(folded.replace(/\.+$/u, ''))) return 'title'
  const withoutDots = folded.replaceAll('.', '')
  if (CREDENTIALS.has(withoutDots)) return 'credential'
  if (GENERATIONAL_SUFFIXES.has(withoutDots)) return 'suffix'
  return 'name'
}

/**
 * Whether `word` is written around a name rather than in it: a doctor's
 * title, a credential or a generational suffix ({@link WordRole}).
 */
const isTitleCredentialOrSuffix = (word: string): boolean => roleOf(word) !== 'name'

/** Whether `word` is a doctor's title. */
const isTitle = ({ role }: Word): boolean => role === 'title'

/** Whether `word` is written around a name rather than in it. */
const isAroundName = ({ role }: Word): boolean => role !== 'name'

/** The words of `words` as written. */
const writtenOf = (words: readonly Word[]): readonly string[] => words.map(({ written }) => written)

/** The whitespace-separated words of `namePart`, each with its role. */
const wordsOf = (namePart: string): readonly Word[] =>
  namePart
    .split(/\s+/u)
    .filter(Str.isNonEmpty)
    .map((written) => ({ written, role: roleOf(written) }))

/** `words` split into the titles leading them and the rest. */
const splitLeadingTitles = (
  words: readonly Word[]
): readonly [titles: readonly Word[], rest: readonly Word[]] => Arr.span(words, isTitle)

/**
 * `words` split into the rest and the titles, credentials and generational
 * suffixes trailing them ("John Smith MD", "John Smith Dr", "Smith Jr").
 */
const splitTrailingAround = (
  words: readonly Word[]
): readonly [rest: readonly Word[], trailing: readonly Word[]] => {
  const [trailingReversed, restReversed] = Arr.span(Arr.reverse(words), isAroundName)
  return [Arr.reverse(restReversed), Arr.reverse(trailingReversed)]
}

/**
 * A name's parts from its `family` and `given` words and the words written
 * `around` it, titles to `prefix` and the rest to `suffix`; `None` when no
 * family name is left.
 */
const partsFrom = (
  family: readonly Word[],
  given: readonly Word[],
  around: readonly Word[]
): Option.Option<Parts> =>
  Option.liftPredicate(
    {
      family: writtenOf(family).join(' '),
      given: writtenOf(given),
      prefix: writtenOf(around.filter(isTitle)),
      suffix: writtenOf(around.filter((word) => !isTitle(word))),
    },
    (parts) => Str.isNonEmpty(parts.family)
  )

/**
 * `family` and `given` words, the family written first, as a name's parts:
 * the titles leading either and the titles, credentials and generational
 * suffixes trailing the given names read around the name, between the words
 * written around it `before` and `after` them.
 */
const familyFirstParts = (
  family: readonly Word[],
  given: readonly Word[],
  { before, after }: { readonly before: readonly Word[]; readonly after: readonly Word[] }
): Option.Option<Parts> => {
  const [familyTitles, familyWords] = splitLeadingTitles(family)
  const [givenTitles, givenRest] = splitLeadingTitles(given)
  const [givenWords, givenTrailing] = splitTrailingAround(givenRest)
  return partsFrom(familyWords, givenWords, [
    ...before,
    ...familyTitles,
    ...givenTitles,
    ...givenTrailing,
    ...after,
  ])
}

/**
 * The comma-separated parts of `text` as words, without an empty part ("John
 * Smith,"), split from the words of the parts trailing them after a comma
 * that hold only titles, credentials and generational suffixes ("John Smith,
 * MD", "John Smith, MD, PhD", "Smith, John, RPh", "Schmitt, John, Jr", "John
 * Smith, Dr."); a first part is always kept.
 */
const splitCommaParts = (
  text: string
): readonly [parts: readonly (readonly Word[])[], trailing: readonly Word[]] => {
  const parts = text.split(',').map(wordsOf).filter(Arr.isNonEmptyReadonlyArray)
  const [trailingReversed, restReversed] = Arr.span(Arr.reverse(parts.slice(1)), (part) =>
    part.every(isAroundName)
  )
  return [
    [...parts.slice(0, 1), ...Arr.reverse(restReversed)],
    Arr.reverse(trailingReversed).flat(),
  ]
}

/**
 * `words`, read without commas, as a name's parts: the titles leading them
 * and the titles, credentials and generational suffixes trailing them read
 * around the name, and the first title left among the rest splitting it,
 * family name before, given names after ("OSEI DR. KWAME"); with no title
 * left, given names then a family name, the last word ("John Smith").
 * `after` are the words written around the name after `words`.
 */
const partsOfWords = (words: readonly Word[], after: readonly Word[]): Option.Option<Parts> => {
  const [leadingTitles, afterTitles] = splitLeadingTitles(words)
  const [nameWords, trailing] = splitTrailingAround(afterTitles)
  const [beforeTitle, fromTitle] = Arr.span(nameWords, (word) => !isTitle(word))
  return Arr.match(fromTitle, {
    onEmpty: () =>
      partsFrom(nameWords.slice(-1), nameWords.slice(0, -1), [
        ...leadingTitles,
        ...trailing,
        ...after,
      ]),
    onNonEmpty: ([title, ...afterTitle]) =>
      familyFirstParts(beforeTitle, afterTitle, {
        before: [...leadingTitles, title],
        after: [...trailing, ...after],
      }),
  })
}

/**
 * The parts `text` is written as, each word as written; `None` when no
 * family name is left.
 *
 * @remarks
 * A doctor's title, a credential or a generational suffix is recognised
 * whatever its case, a title with or without the dot ending it ("Dr", "DR.")
 * and a credential or a suffix whatever its dots ("M.D."), and read into
 * `prefix` (a title) or `suffix` (the others) rather than the name. The
 * reading runs in three steps:
 *
 * 1. The parts trailing the text after a comma that hold only titles,
 *    credentials and generational suffixes are read around the name ("John
 *    Smith, MD", "Schmitt, John, Jr", "John Smith, Dr."), and an empty part
 *    ("John Smith,") is dropped.
 * 2. When exactly one comma is left, the family name is written first
 *    ("Schmitt, John Jacob"): the comma, not a title, ends it, and the titles
 *    leading either side ("Brown, Dr. Jonathan") and the titles, credentials
 *    and generational suffixes trailing the given names ("Schmitt, John Jr",
 *    "Smith, John Dr.") are read around the name.
 * 3. Otherwise any other commas read as spaces, the titles leading the words
 *    and the titles, credentials and generational suffixes trailing them are
 *    read around the name ("Dr. John Smith Jr", "DR J BROWN MD", "John Smith
 *    Dr"), and the first title left among them splits the name: family name
 *    before it, given names after it ("OSEI DR. KWAME"). With no title left
 *    the last word is the family name and the words before it the given
 *    names.
 */
const partsOfText = (text: string): Option.Option<Parts> => {
  const [parts, trailing] = splitCommaParts(text)
  const [family, given] = parts
  return parts.length === 2 && family !== undefined && given !== undefined
    ? familyFirstParts(family, given, { before: [], after: trailing })
    : partsOfWords(parts.flat(), trailing)
}

/**
 * The parts of `name`: its `family` and `given` when it states either, the
 * doctor's titles leading each read into `prefix`, else its `text`
 * ({@link partsOfText}); `None` when no family name is left. The name's own
 * `prefix` and `suffix` are not read.
 */
const partsOf = (name: Pick<Displayable, 'family' | 'given' | 'text'>): Option.Option<Parts> => {
  if ((name.family ?? null) === null && (name.given ?? []).length === 0) {
    return partsOfText(name.text ?? '')
  }
  const [familyTitles, family] = splitLeadingTitles(wordsOf(name.family ?? ''))
  const [givenTitles, given] = splitLeadingTitles((name.given ?? []).flatMap(wordsOf))
  return partsFrom(family, given, [...familyTitles, ...givenTitles])
}

export { comparableWordOf, isTitleCredentialOrSuffix, partsOf, partsOfText }
export type { Parts }

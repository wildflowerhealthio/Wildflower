import { Array, Option, Order, String as Str } from 'effect'

import type { HumanName } from '../data-types/index.ts'
import type * as Patient from '../resources/patient/patient.ts'
import type * as Practitioner from '../resources/practitioner/practitioner.ts'

/**
 * How well a stored record matches a query, graded as FHIR's `$match` grades
 * a candidate (the `match-grade` extension's value set), and the grading of
 * Patients and Practitioners by name (and a Patient's birth date).
 *
 * @packageDocumentation
 */

/**
 * A candidate's grade: `certain` (the one stored record carrying any of
 * the query's identifiers), `probable` and `possible` (it agrees with the
 * query, more or less), and `certainly-not`, which the value set holds and
 * nothing here gives.
 */
type Type = 'certain' | 'probable' | 'possible' | 'certainly-not'

const RANK: { readonly [Grade in Type]: number } = {
  certain: 0,
  probable: 1,
  possible: 2,
  'certainly-not': 3,
}

/** Grades best first: `certain`, `probable`, `possible`, `certainly-not`. */
const bestFirst: Order.Order<Type> = Order.mapInput(Order.number, (grade: Type) => RANK[grade])

/**
 * A name as two names are compared: a family name, and the given names, each
 * part's words lower-cased, without diacritics and single-spaced, with a
 * leading doctor's title dropped.
 */
interface ComparableName {
  readonly family: string
  readonly given: readonly string[]
}

/** The words a doctor's title is written as, compared once lower-cased. */
const DOCTOR_TITLES: ReadonlySet<string> = new Set(['dr', 'dr.', 'doctor'])

/**
 * The words a credential is written as after a name ("John Smith, MD"),
 * compared once lower-cased and without dots. Credentials that are also
 * names ("Do", "Pa", "Od") are left out, so "Nguyen, Do" keeps its given name.
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
 * "Schmitt, John, Jr"), compared once lower-cased and without dots.
 */
const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])

/** The words of `namePart`, lower-cased and without diacritics (decomposed, combining marks dropped). */
const wordsOf = (namePart: string): readonly string[] =>
  namePart
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Str.isNonEmpty)

/** `words` without a doctor's title leading them. */
const withoutLeadingTitle = (words: readonly string[]): readonly string[] =>
  Array.match(words, {
    onEmpty: () => words,
    onNonEmpty: (spoken) =>
      DOCTOR_TITLES.has(Array.headNonEmpty(spoken)) ? Array.tailNonEmpty(spoken) : spoken,
  })

/** Whether `word`, without its dots, is a generational suffix ({@link GENERATIONAL_SUFFIXES}). */
const isGenerationalSuffix = (word: string): boolean =>
  GENERATIONAL_SUFFIXES.has(word.replaceAll('.', ''))

/**
 * Whether `words` are a tail a name can drop: at least one word, every one
 * of them a credential ({@link CREDENTIALS}) or a generational suffix.
 */
const isDroppableTail = (words: readonly string[]): boolean =>
  Array.isNonEmptyReadonlyArray(words) &&
  words.every((word) => CREDENTIALS.has(word.replaceAll('.', '')) || isGenerationalSuffix(word))

/** `words` without the generational suffixes trailing them; a first word is always kept. */
const withoutTrailingSuffixes = (words: readonly string[]): readonly string[] =>
  words.length > 1 && isGenerationalSuffix(words.at(-1) ?? '')
    ? withoutTrailingSuffixes(words.slice(0, -1))
    : words

/** `family` and `given` words as a comparable name; `None` when no family name is left. */
const comparableNameFrom = (
  familyWords: readonly string[],
  givenWords: readonly string[]
): Option.Option<ComparableName> => {
  const family = withoutLeadingTitle(familyWords).join(' ')
  return Option.liftPredicate({ family, given: withoutLeadingTitle(givenWords) }, () =>
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
  return withoutTail(text.split(',').map(wordsOf).filter(Array.isNonEmptyReadonlyArray))
}

/**
 * `text` as a comparable name, its credential and suffix tail dropped first
 * ({@link partsWithoutDroppableTail}): family first when exactly one comma
 * is left ("Schmitt, John Jacob"), the given names without the generational
 * suffixes trailing them ("Schmitt, John Jr"), else given names then a
 * family name, the last word once trailing generational suffixes are dropped
 * ("John Smith Jr"), with any other commas read as spaces.
 */
const comparableTextNameOf = (text: string): Option.Option<ComparableName> => {
  const parts = partsWithoutDroppableTail(text)
  if (parts.length === 2) {
    return comparableNameFrom(parts[0] ?? [], withoutTrailingSuffixes(parts[1] ?? []))
  }
  const textWords = withoutTrailingSuffixes(withoutLeadingTitle(parts.flat()))
  return Option.map(Array.last(textWords), (family) => ({
    family,
    given: textWords.slice(0, -1),
  }))
}

/**
 * `name` as it is compared: its `family` and `given` parts when it states
 * either, else its `text` ({@link comparableTextNameOf}); `None` when no
 * family name is left, so a name without one is not compared. `prefix` and
 * `suffix` are not compared, so a title written there is ignored as one
 * written leading the text, the family or the given names is.
 */
const comparableNameOf = (name: typeof HumanName.Schema.Type): Option.Option<ComparableName> =>
  name.family !== null || name.given.length > 0
    ? comparableNameFrom(wordsOf(name.family ?? ''), name.given.flatMap(wordsOf))
    : comparableTextNameOf(name.text ?? '')

/** Every name of `names` that can be compared ({@link comparableNameOf}), in record order. */
const comparableNamesOf = (
  names: readonly (typeof HumanName.Schema.Type)[]
): readonly ComparableName[] => Array.filterMap(names, comparableNameOf)

/**
 * Whether `word` can find the names it is part of: not a doctor's title
 * ({@link DOCTOR_TITLES}), a credential ({@link CREDENTIALS}) or a
 * generational suffix, and more than one letter once its dots are dropped,
 * so not an initial.
 */
const isSearchableWord = (word: string): boolean => {
  const withoutDots = word.replaceAll('.', '')
  return (
    withoutDots.length > 1 &&
    !DOCTOR_TITLES.has(word) &&
    !CREDENTIALS.has(withoutDots) &&
    !GENERATIONAL_SUFFIXES.has(withoutDots)
  )
}

/**
 * The words of the family names of `names`, as {@link comparableNamesOf}
 * reads them (lower-cased, without diacritics), each once, without the words
 * that cannot find a name ({@link isSearchableWord}): what a `name` search
 * for the records `names` can grade against is sent with.
 */
const familySearchWordsOf = (names: readonly (typeof HumanName.Schema.Type)[]): readonly string[] =>
  Array.dedupe(
    comparableNamesOf(names).flatMap(({ family }) => family.split(' ').filter(isSearchableWord))
  )

/** Whether `queryName` has a given name and every one it has is among `storedName`'s. */
const givenNamesCovered = (queryName: ComparableName, storedName: ComparableName): boolean =>
  Array.isNonEmptyReadonlyArray(queryName.given) &&
  queryName.given.every((given) => storedName.given.includes(given))

/** Whether any given name of `queryName` is among `storedName`'s. */
const anyGivenNameShared = (queryName: ComparableName, storedName: ComparableName): boolean =>
  queryName.given.some((given) => storedName.given.includes(given))

/** Whether both names have a first given name and the two start with the same letter. */
const firstInitialsAgree = (queryName: ComparableName, storedName: ComparableName): boolean =>
  Option.zipWith(
    Array.head(queryName.given),
    Array.head(storedName.given),
    (queryGiven, storedGiven) => queryGiven[0] === storedGiven[0]
  ).pipe(Option.getOrElse(() => false))

/**
 * A patient's name against a stored one, their birth dates already equal:
 * `probable` when the family names are equal and the stored name has every
 * given name the query's has (at least one); `possible` when the family
 * names are equal and the given names are not so covered, or when the family
 * names differ and any given name is shared.
 */
const patientNameGrade = (
  queryName: ComparableName,
  storedName: ComparableName
): Option.Option<Type> => {
  if (queryName.family === storedName.family) {
    return Option.some(givenNamesCovered(queryName, storedName) ? 'probable' : 'possible')
  }
  return anyGivenNameShared(queryName, storedName) ? Option.some('possible') : Option.none()
}

/**
 * A practitioner's name against a stored one: `probable` when the family
 * names are equal and the stored name has every given name the query's has
 * (at least one); `possible` when the family names are equal and the query
 * has no given name ("Dr. Smith"), or the first given names share their
 * initial (`J` and `Jonathan`).
 */
const practitionerNameGrade = (
  queryName: ComparableName,
  storedName: ComparableName
): Option.Option<Type> => {
  if (queryName.family !== storedName.family) return Option.none()
  if (givenNamesCovered(queryName, storedName)) return Option.some('probable')
  return Array.isEmptyReadonlyArray(queryName.given) || firstInitialsAgree(queryName, storedName)
    ? Option.some('possible')
    : Option.none()
}

/** The best grade any name of `queryNames` takes against any of `storedNames` by `nameGrade`. */
const bestNameGrade = (
  queryNames: readonly (typeof HumanName.Schema.Type)[],
  storedNames: readonly (typeof HumanName.Schema.Type)[],
  nameGrade: (queryName: ComparableName, storedName: ComparableName) => Option.Option<Type>
): Option.Option<Type> => {
  const comparableStoredNames = comparableNamesOf(storedNames)
  const grades = comparableNamesOf(queryNames).flatMap((queryName) =>
    Array.filterMap(comparableStoredNames, (storedName) => nameGrade(queryName, storedName))
  )
  return Array.isNonEmptyReadonlyArray(grades)
    ? Option.some(Array.min(grades, bestFirst))
    : Option.none()
}

/**
 * Whether the Patient `query` can grade any stored Patient
 * ({@link patientGradeOf}): it states a birth date and has a name with a
 * family name.
 */
const canGradePatient = (query: Patient.Type): boolean =>
  query.birthDate !== null && Array.isNonEmptyReadonlyArray(comparableNamesOf(query.name))

/**
 * Whether the Practitioner `query` can grade any stored Practitioner
 * ({@link practitionerGradeOf}): it has a name with a family name.
 */
const canGradePractitioner = (query: Practitioner.Type): boolean =>
  Array.isNonEmptyReadonlyArray(comparableNamesOf(query.name))

/**
 * The grade the stored Patient `stored` takes as a match of `query`:
 * `probable` or `possible` by name ({@link patientNameGrade}) when both state
 * the same birth date, else `None`.
 *
 * @remarks
 * Names compare as {@link comparableNameOf} reads them, any name of the
 * query against any name of the stored record, the best grade winning. The
 * comparison is exact once normalised: no phonetic or fuzzy matching.
 */
const patientGradeOf = (query: Patient.Type, stored: Patient.Type): Option.Option<Type> =>
  query.birthDate !== null && query.birthDate === stored.birthDate
    ? bestNameGrade(query.name, stored.name, patientNameGrade)
    : Option.none()

/**
 * The grade the stored Practitioner `stored` takes as a match of `query`:
 * `probable` or `possible` by name ({@link practitionerNameGrade}), else
 * `None`. Names compare as {@link patientGradeOf}'s do.
 */
const practitionerGradeOf = (
  query: Practitioner.Type,
  stored: Practitioner.Type
): Option.Option<Type> => bestNameGrade(query.name, stored.name, practitionerNameGrade)

export {
  bestFirst,
  canGradePatient,
  canGradePractitioner,
  comparableNamesOf,
  familySearchWordsOf,
  patientGradeOf,
  practitionerGradeOf,
}
export type { ComparableName, Type }

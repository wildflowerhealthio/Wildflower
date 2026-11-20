import { Array, Option, Order, String as Str } from 'effect'

import { HumanName } from '../data-types/index.ts'
import type * as Patient from '../resources/patient/patient.ts'
import type * as Practitioner from '../resources/practitioner/practitioner.ts'

/**
 * How well a stored resource matches a query, graded as FHIR's `$match` grades
 * a candidate (the `match-grade` extension's value set), and the grading of
 * Patients and Practitioners by name (and a Patient's birth date).
 *
 * @packageDocumentation
 */

/**
 * A candidate's grade: `certain` (the one stored resource carrying any of
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
 * Whether `grade` is `certain` or `probable`. In FHIR's match-grade value
 * set these are the grades whose definitions leave additional review
 * optional, where a `possible` match is one to review.
 */
const mayNotNeedAdditionalReview = (grade: Type): boolean =>
  grade === 'certain' || grade === 'probable'

/**
 * A name as two names are compared: its parts as {@link HumanName.partsOf}
 * reads them, each word lower-cased and without diacritics.
 */
interface ComparableName {
  readonly family: string
  readonly given: readonly string[]
}

/** `words` as compared ({@link HumanName.comparableWordOf}), without a word that leaves nothing. */
const comparableWordsOf = (words: readonly string[]): readonly string[] =>
  words.map(HumanName.comparableWordOf).filter(Str.isNonEmpty)

/**
 * `name` as it is compared: its parts ({@link HumanName.partsOf}), each word
 * lower-cased and without diacritics; `None` when no family name is left, so
 * a name without one is not compared.
 */
const comparableNameOf = (name: typeof HumanName.Schema.Type): Option.Option<ComparableName> =>
  HumanName.partsOf(name).pipe(
    Option.map(({ family, given }): ComparableName => ({
      family: comparableWordsOf(family.split(' ')).join(' '),
      given: comparableWordsOf(given),
    })),
    Option.filter(({ family }) => Str.isNonEmpty(family))
  )

/** Every name of `names` that can be compared ({@link comparableNameOf}), in the order of `names`. */
const comparableNamesOf = (
  names: readonly (typeof HumanName.Schema.Type)[]
): readonly ComparableName[] => Array.filterMap(names, comparableNameOf)

/**
 * Whether `word` can find the names it is part of: not a doctor's title, a
 * credential or a generational suffix ({@link HumanName.isTitleCredentialOrSuffix}),
 * and more than one letter once its dots are dropped, so not an initial.
 */
const isSearchableWord = (word: string): boolean =>
  word.replaceAll('.', '').length > 1 && !HumanName.isTitleCredentialOrSuffix(word)

/**
 * The words of the family names of `names`, as {@link comparableNamesOf}
 * reads them (lower-cased, without diacritics), each once, without the words
 * that cannot find a name ({@link isSearchableWord}): what a `name` search
 * for the resources `names` can grade against is sent with.
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
 * query against any name of the stored resource, the best grade winning. The
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
  mayNotNeedAdditionalReview,
  patientGradeOf,
  practitionerGradeOf,
}
export type { ComparableName, Type }

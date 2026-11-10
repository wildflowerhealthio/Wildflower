import { Array, Match, Option, Order, String as Str } from 'effect'

import type { HumanName } from '../data-types/index.ts'
import type * as MatchQuery from './match-query.ts'

/**
 * How well a stored record matches a query, graded as FHIR's `$match` grades
 * a candidate (the `match-grade` extension's value set), and the grading of
 * people by name and birth date.
 *
 * @packageDocumentation
 */

/**
 * A candidate's grade: `certain` (it carries one of the query's
 * identifiers), `probable` and `possible` (its name and birth date agree, more
 * or less), and `certainly-not`, which the value set holds and nothing here
 * gives.
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

/**
 * `name` as it is compared: its `family` and `given` parts when it states
 * either, else its `text` read as given names then a family name (the last
 * word); `None` when no family name is left, since every grade needs one.
 * `prefix` and `suffix` are not compared, so a title written there is
 * ignored as one written leading the text, the family or the given names is.
 */
const comparableNameOf = (name: typeof HumanName.Schema.Type): Option.Option<ComparableName> => {
  if (name.family !== null || name.given.length > 0) {
    const family = withoutLeadingTitle(wordsOf(name.family ?? '')).join(' ')
    const given = withoutLeadingTitle(name.given.flatMap(wordsOf))
    return Option.liftPredicate({ family, given }, () => Str.isNonEmpty(family))
  }
  const textWords = withoutLeadingTitle(wordsOf(name.text ?? ''))
  return Option.map(Array.last(textWords), (family) => ({
    family,
    given: textWords.slice(0, -1),
  }))
}

/** Every name of `names` that can be compared ({@link comparableNameOf}), in record order. */
const comparableNamesOf = (
  names: readonly (typeof HumanName.Schema.Type)[]
): readonly ComparableName[] => Array.filterMap(names, comparableNameOf)

/** Whether every given name `queryName` has is among `storedName`'s. */
const givenNamesCovered = (queryName: ComparableName, storedName: ComparableName): boolean =>
  queryName.given.every((given) => storedName.given.includes(given))

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
 * given name the query's has, `possible` when only the family names are.
 */
const patientNameGrade = (
  queryName: ComparableName,
  storedName: ComparableName
): Option.Option<Type> =>
  queryName.family !== storedName.family
    ? Option.none()
    : Option.some(givenNamesCovered(queryName, storedName) ? 'probable' : 'possible')

/**
 * A practitioner's name against a stored one: `probable` when the family names
 * are equal and the stored name has every given name the query's has,
 * `possible` when the family names are equal and the first given names share
 * their initial (`J` and `Jonathan`).
 */
const practitionerNameGrade = (
  queryName: ComparableName,
  storedName: ComparableName
): Option.Option<Type> => {
  if (queryName.family !== storedName.family) return Option.none()
  if (givenNamesCovered(queryName, storedName)) return Option.some('probable')
  return firstInitialsAgree(queryName, storedName) ? Option.some('possible') : Option.none()
}

/** The best grade any of `query`'s names takes against any of `stored`'s by `nameGrade`. */
const bestNameGrade = (
  query: MatchQuery.Type,
  stored: MatchQuery.Type,
  nameGrade: (queryName: ComparableName, storedName: ComparableName) => Option.Option<Type>
): Option.Option<Type> => {
  const storedNames = comparableNamesOf(stored.name)
  const grades = comparableNamesOf(query.name).flatMap((queryName) =>
    Array.filterMap(storedNames, (storedName) => nameGrade(queryName, storedName))
  )
  return Array.isNonEmptyReadonlyArray(grades)
    ? Option.some(Array.min(grades, bestFirst))
    : Option.none()
}

/**
 * The grade `stored` takes as a match of `query` by name and birth date:
 * `probable` or `possible`, or `None` when it is neither.
 *
 * @remarks
 * Only people are graded so: a Patient by family name, given names and birth
 * date (both stating the same one), a Practitioner by family name and given
 * names; any other record, or a stored record of another type, is `None`.
 * Names compare as {@link comparableNameOf} reads them, any name of the
 * query against any name of the stored record, the best grade winning. The
 * comparison is exact once normalised: no phonetic or fuzzy matching.
 */
const demographicGradeOf = (query: MatchQuery.Type, stored: MatchQuery.Type): Option.Option<Type> =>
  query.resourceType !== stored.resourceType
    ? Option.none()
    : Match.value(query.resourceType).pipe(
        Match.when('Patient', () =>
          query.birthDate !== null && query.birthDate === stored.birthDate
            ? bestNameGrade(query, stored, patientNameGrade)
            : Option.none()
        ),
        Match.when('Practitioner', () => bestNameGrade(query, stored, practitionerNameGrade)),
        Match.orElse(() => Option.none())
      )

export { bestFirst, comparableNamesOf, demographicGradeOf }
export type { ComparableName, Type }

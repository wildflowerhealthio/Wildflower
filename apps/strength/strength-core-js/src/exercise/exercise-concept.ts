import {
  CodeableConcept,
  Code,
  Coding,
  narrowFields,
  WildflowerCodeSystem,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { type Brand, type Either, Option, type ParseResult, pipe, Schema } from 'effect'

import { checkArrayHasOneMatchingElement } from '../internal/check-array-has-one-matching-element.ts'
import { guaranteed } from '../internal/guaranteed.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'

/**
 * The exercise id a display name slugs to: lowercased, diacritics folded,
 * every run of other characters collapsed to one hyphen, and no hyphen at
 * either end — `"Bench Press"` → `bench-press`, `"Développé Couché"` →
 * `developpe-couche`.
 *
 * @remarks
 * Idempotent: an id it produces slugs to itself. Only `[a-z0-9-]` comes out,
 * so a name of nothing but other characters slugs to the empty string, which
 * is not an exercise id.
 */
const idFromName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** An exercise id: a non-empty slug, what {@link idFromName} makes of itself. */
const ExerciseIdCode = Code.pipe(
  Schema.filter((id) => id !== '' && idFromName(id) === id, {
    message: (issue) =>
      `expected an exercise id slug, like "bench-press", actual ${JSON.stringify(issue.actual)}`,
  })
)

/**
 * What the (already decoded) one coding of an exercise concept must carry: a
 * slug `code` and a non-empty, trimmed `display`.
 */
const ExerciseCodingSchema = Schema.Struct({
  code: ExerciseIdCode,
  display: Schema.NonEmptyTrimmedString,
})

/** A coding as {@link ExerciseCodingSchema} reads it. */
const readExerciseCoding = Schema.validateOption(ExerciseCodingSchema)

/**
 * An exercise, as FHIR codes it: a `CodeableConcept` narrowed to exactly one
 * coding in {@link WildflowerCodeSystem.Exercise}, whose `code` is the
 * exercise id — a stable slug (`squat`, `bench-press`) `ExerciseRequest`s and sets are
 * keyed by, persisted, so never renamed — and whose `display` is the name a
 * person reads.
 *
 * @remarks
 * Codings in other systems ride along untouched. The concept's `text` is the
 * name too, so a generic viewer can label a resource coded with it.
 */
interface Type extends CodeableConcept.Type, Brand.Brand<'ExerciseConcept'> {}

/**
 * Decodes a `CodeableConcept` into a {@link Type} — fails when it has no
 * exercise coding or several, or the one it has lacks a slug code or a
 * non-empty, trimmed display.
 */
const ExerciseConceptSchema: Schema.Schema<Type, CodeableConcept.Type> =
  narrowedFrom<CodeableConcept.Type>()(
    narrowFields(Schema.typeSchema(CodeableConcept.Schema), {
      coding: Schema.Array(Schema.typeSchema(Coding.Schema)).pipe(
        Schema.filter(
          checkArrayHasOneMatchingElement({
            matches: Coding.isInSystem(WildflowerCodeSystem.Exercise),
            schema: ExerciseCodingSchema,
            expected: `coding in ${WildflowerCodeSystem.Exercise}`,
          })
        )
      ),
    }).pipe(Schema.brand('ExerciseConcept'))
  )

/**
 * The exercise named `name`, under the id `id`.
 *
 * @returns The concept; or a `ParseError` when `id` is not a slug or `name`
 *   is empty or untrimmed
 */
const make = (exercise: {
  readonly id: string
  readonly name: string
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(ExerciseConceptSchema, { errors: 'all' })(
    CodeableConcept.make({
      system: WildflowerCodeSystem.Exercise,
      code: exercise.id,
      display: exercise.name,
      text: exercise.name,
    })
  )

/** The exercise's one coding, narrowed. */
const exerciseCodingOf = (concept: Type): typeof ExerciseCodingSchema.Type =>
  guaranteed(
    pipe(
      CodeableConcept.onlyCodingIn(concept, WildflowerCodeSystem.Exercise),
      Option.flatMap(readExerciseCoding)
    )
  )

/** The exercise id: the slug its coding's `code` holds. */
const idOf = (concept: Type): string => exerciseCodingOf(concept).code

/** The exercise's display name: its coding's `display`. */
const nameOf = (concept: Type): string => exerciseCodingOf(concept).display

export { ExerciseConceptSchema as Schema, idFromName, idOf, make, nameOf }
export type { Type }

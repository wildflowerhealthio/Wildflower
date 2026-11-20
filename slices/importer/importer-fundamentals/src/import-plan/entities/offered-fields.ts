/**
 * Offered fields: what an import resource offers an existing stored record,
 * top-level field by top-level field.
 *
 * @packageDocumentation
 */
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'

/**
 * The fields an import resource offers an existing record, and the
 * identifiers it adds to it.
 *
 * @remarks
 * A field is offered when the import has a value for it and the value
 * differs from the existing record's. It fills a gap when the existing record
 * has no value for it, and overwrites one otherwise. The import's identifiers
 * are always added, so `identifier` is never offered. `id`, `meta` and the
 * fields `normalizedEncode` drops are not fields here.
 */
interface Type {
  /** Offered fields the existing record has no value for, in the import's field order. */
  readonly gapFilling: readonly string[]
  /** Offered fields the existing record has another value for, in the import's field order. */
  readonly overwriting: readonly string[]
  /** The import's qualified identifiers the existing record does not carry. */
  readonly identifiersToAdd: readonly IdentifierAndReference.QualifiedIdentifierType[]
}

/** The offered fields of `gapFilling` and `overwriting` fields, adding `identifiersToAdd`. */
const make = ({ gapFilling, overwriting, identifiersToAdd }: Type): Type => ({
  gapFilling,
  overwriting,
  identifiersToAdd,
})

/** Whether `offeredFields` offers no field: the import is the same as the existing record. */
const offersNoField = (offeredFields: Type): boolean =>
  offeredFields.gapFilling.length === 0 && offeredFields.overwriting.length === 0

export { make, offersNoField }
export type { Type }

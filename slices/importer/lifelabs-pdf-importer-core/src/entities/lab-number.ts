import { Schema } from 'effect'

/**
 * A report's `Lab No` as printed (`2024-JJ6330780`): the report's identity,
 * never blank.
 *
 * @remarks
 * `Report.tryFromDocument` skips a page that prints no `Lab No`, and a
 * caller building a report itself goes through {@link make}, which refuses a
 * blank one. Nothing is read into the value: a
 * masked `0000-XX0000000` is a Lab No like any other.
 *
 * @packageDocumentation
 */

/** A printed `Lab No`: trimmed text, never blank. */
const LabNumberSchema = Schema.NonEmptyTrimmedString

/** A report's `Lab No` as printed, never blank. */
type Type = typeof LabNumberSchema.Type

/** A printed `Lab No`; throws on a blank or untrimmed one. */
const make = (printed: string): Type => LabNumberSchema.make(printed)

export { LabNumberSchema as Schema, make }
export type { Type }

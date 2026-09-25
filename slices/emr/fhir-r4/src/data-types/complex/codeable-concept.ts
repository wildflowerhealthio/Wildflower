import { Array as Arr, Option, pipe, Schema } from 'effect'

import { nonEmpty } from 'kitchen-sink'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Coding from './coding.ts'

const CodeableConceptStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    coding: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.suspend(() => Coding.Schema))), {
      default: (): readonly (typeof Coding.Schema.Type)[] => [],
    }),
    text: OrNullAsOptional(Schema.String),
  })
)

const CodeableConceptSchema: Schema.Schema<
  typeof CodeableConceptStruct.Type,
  FhirR4.CodeableConcept,
  never
> = CodeableConceptStruct

registerDatatypeSchema('CodeableConcept', CodeableConceptSchema)

/**
 * The fields a concept's label is read from. A decoded concept has them, and so
 * does one still in raw wire JSON (where absence may be `undefined`), so a
 * writer working on passthrough `contained` data reads a label by the same rule
 * a reader does.
 */
interface Labelled {
  readonly text?: string | null | undefined
  readonly coding?: readonly { readonly display?: string | null | undefined }[] | undefined
}

/**
 * The concept's human-readable label: its `text`, else the first coding's
 * `display`. A blank value counts as absent.
 *
 * @remarks
 * `text` wins because R4 defines it as the concept "as entered or chosen by the
 * user" — the source's own words — whereas a coding's `display` is the code
 * system's name for that one code.
 */
const label = (concept: Labelled): Option.Option<string> =>
  pipe(
    Option.fromNullable(nonEmpty(concept.text)),
    Option.orElse(() =>
      Arr.findFirst(concept.coding ?? [], (coding) => Option.fromNullable(nonEmpty(coding.display)))
    )
  )

export { CodeableConceptSchema as Schema, label }

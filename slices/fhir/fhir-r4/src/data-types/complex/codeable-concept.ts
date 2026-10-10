import { Array as Arr, Option, pipe, Schema, String as Str } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
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
    Option.fromNullable(concept.text),
    Option.filter(Str.isNonEmpty),
    Option.orElse(() =>
      Arr.findFirst(concept.coding ?? [], (coding) =>
        pipe(Option.fromNullable(coding.display), Option.filter(Str.isNonEmpty))
      )
    )
  )

/** A decoded `CodeableConcept` — the type {@link CodeableConceptSchema} produces. */
type Type = typeof CodeableConceptStruct.Type

/**
 * A concept of one coding: `code` under `system`, with its `display`, and the
 * concept's own `text`.
 *
 * @param coding - The system url and code, and the display and text to write
 *   (`null` to leave either out)
 * @returns The decoded concept, every other slot empty
 */
const make = (coding: {
  readonly system: string
  readonly code: string
  readonly display: string | null
  readonly text: string | null
}): Type => ({
  id: null,
  extension: [],
  coding: [
    {
      id: null,
      extension: [],
      system: new URL(coding.system),
      code: Code.make(coding.code),
      display: coding.display,
      userSelected: null,
      version: null,
    },
  ],
  text: coding.text,
})

/**
 * The single coding of `concept` under `system`; `None` when it has none
 * there, or several — a concept coded twice in one system names no one code.
 */
const onlyCodingIn = (concept: Type, system: string): Option.Option<Coding.Type> => {
  const inSystem = concept.coding.filter(Coding.isInSystem(system))
  return inSystem.length === 1 ? Arr.head(inSystem) : Option.none()
}

export { CodeableConceptSchema as Schema, label, make, onlyCodingIn }
export type { Type }

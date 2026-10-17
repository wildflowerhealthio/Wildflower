import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as FhirString from '../base/fhir-string.ts'

const CodingStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    code: OrNullAsOptional(Code),
    display: FhirString.Optional,
    system: OrNullAsOptional(Schema.URL),
    userSelected: OrNullAsOptional(Schema.Boolean),
    version: FhirString.Optional,
  })
)

type Type = typeof CodingStruct.Type

const CodingSchema: Schema.Schema<Type, FhirR4.Coding, never> = CodingStruct

registerDatatypeSchema('Coding', CodingSchema)

/**
 * Whether a coding is under `system` — a predicate for `Array.find` /
 * `Array.filter` over a concept's `coding`. Compared by `href`, since a decoded
 * `Coding.system` is a `URL`.
 */
const isInSystem =
  (system: string) =>
  (coding: Type): boolean =>
    coding.system?.href === system

export { CodingSchema as Schema, isInSystem }
export type { Type }

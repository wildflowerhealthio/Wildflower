import { Schema } from 'effect'

import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'

/**
 * FHIR R4 value set for `Patient.link.type`: replaced-by | replaces |
 * refer | seealso. Indicates the kind of relationship between linked
 * Patient resources.
 */
const TypeSchema = Schema.Enums({
  refer: 'refer',
  'replaced-by': 'replaced-by',
  replaces: 'replaces',
  seealso: 'seealso',
} as const)

const PatientLinkStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    other: Schema.suspend(() => Reference.ReferenceSchema),
    type: TypeSchema,
  })
)

const PatientLinkSchema: Schema.Schema<typeof PatientLinkStruct.Type, FhirR4.PatientLink, never> =
  PatientLinkStruct

export { PatientLinkSchema as Schema, TypeSchema }

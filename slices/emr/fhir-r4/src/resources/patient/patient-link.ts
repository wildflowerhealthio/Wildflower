import { Schema } from 'effect'

import { Patient as StorePatient } from 'emr-core/livestore'
import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'

const PatientLinkSchema: Schema.Schema<
  typeof StorePatient.Link.Schema.Type,
  FhirR4.PatientLink,
  never
> = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    other: Schema.suspend(() => Reference.ReferenceSchema),
    type: StorePatient.Link.TypeSchema,
  })
)

export { PatientLinkSchema as Schema }

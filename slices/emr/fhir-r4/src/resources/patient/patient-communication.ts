import { Schema } from 'effect'

import type { Patient as StorePatient } from 'emr-core/livestore'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'

const PatientCommunicationSchema: Schema.Schema<
  typeof StorePatient.Communication.Schema.Type,
  FhirR4.PatientCommunication,
  never
> = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    language: Schema.suspend(() => CodeableConcept.Schema),
    preferred: OrNullAsOptional(Schema.Boolean),
  })
)

export { PatientCommunicationSchema as Schema }

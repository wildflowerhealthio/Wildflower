import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'

const PatientCommunicationStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    language: Schema.suspend(() => CodeableConcept.Schema),
    preferred: OrNullAsOptional(Schema.Boolean),
  })
)

const PatientCommunicationSchema: Schema.Schema<
  typeof PatientCommunicationStruct.Type,
  FhirR4.PatientCommunication,
  never
> = PatientCommunicationStruct

export { PatientCommunicationSchema as Schema }

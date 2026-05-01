import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as CodeableConcept from '../schemas/datatypes/codeable-concept.ts'

const ResourceType = 'PatientCommunication' as const
type ResourceType = typeof ResourceType

const fields = {
  language: CodeableConcept.Schema,
  preferred: Schema.NullOr(Schema.Boolean),
} as const satisfies FieldsNoContext

/** A language spoken by the patient, with an optional preference flag. */
const PatientCommunicationSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, PatientCommunicationSchema as Schema }

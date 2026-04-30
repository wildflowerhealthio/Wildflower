import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'

const ResourceType = 'PatientCommunication' as const
type ResourceType = typeof ResourceType

const fields = {
  language: CodeableConcept.Schema,
  preferred: ES.NullOr(ES.Boolean),
} as const satisfies FieldsNoContext

/** A language spoken by the patient, with an optional preference flag. */
const Schema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, Schema }

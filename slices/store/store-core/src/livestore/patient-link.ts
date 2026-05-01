import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as Reference from '../schemas/complex/reference.ts'

const ResourceType = 'PatientLink' as const
type ResourceType = typeof ResourceType

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
type Type = typeof TypeSchema.Type

const fields = {
  other: Reference.Schema,
  type: TypeSchema,
} as const satisfies FieldsNoContext

/** A link to another Patient resource that concerns the same actual patient. */
const PatientLinkSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, TypeSchema, PatientLinkSchema as Schema }
export type { Type }

import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../schemas/base/backbone-element.ts'
import * as Reference from '../schemas/complex/reference.ts'

const ResourceType = 'PatientLink' as const
type ResourceType = typeof ResourceType

/**
 * This element is labeled as a modifier because it may be used to mark that the
 * resource was created in error.
 */
const PatientLinkType = ES.Enums({
  refer: 'refer',
  'replaced-by': 'replaced-by',
  replaces: 'replaces',
  seealso: 'seealso',
} as const)

const fields = {
  other: Reference.Schema,
  type: PatientLinkType,
} as const satisfies FieldsNoContext

/** A link to another Patient resource that concerns the same actual patient. */
const Schema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

export { ResourceType, PatientLinkType, Schema }

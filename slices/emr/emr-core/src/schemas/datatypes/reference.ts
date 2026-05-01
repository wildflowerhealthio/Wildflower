import { Schema } from 'effect'

import { registerDatatypeSchema } from '../datatype-registry.ts'
import { ReferenceResourceType, ReferenceSchema } from './identifier-and-reference.ts'

/**
 * Creates a Reference pointing to a resource, or `undefined` if the
 * resource has no URL. Sets `type` from `resourceType`.
 */
const fromResource = (
  resource: {
    readonly meta: { readonly source?: string | undefined }
    readonly resourceType: string
  },
  display: string | null = null
): typeof ReferenceSchema.Type | undefined => {
  if (!resource.meta.source) {
    return undefined
  }
  return Schema.decodeSync(ReferenceSchema)({
    display,
    reference: resource.meta.source,
    type: resource.resourceType,
    id: null,
    extension: [],
    identifier: null,
  })
}

registerDatatypeSchema(ReferenceResourceType, ReferenceSchema)

export { fromResource, ReferenceResourceType as ResourceType, ReferenceSchema as Schema }

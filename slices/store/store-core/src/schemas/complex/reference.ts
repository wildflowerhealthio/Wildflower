import { Schema as ES } from 'effect'

import { Datatype as makeDatatype } from '../datatype.ts'
import {
  ReferenceResourceType as ResourceType,
  ReferenceSchema as Schema,
} from './identifier-and-reference.ts'

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
): typeof Schema.Type | undefined => {
  if (!resource.meta.source) {
    return undefined
  }
  return ES.decodeSync(Schema)({
    display,
    reference: resource.meta.source,
    type: resource.resourceType,
    id: null,
    extension: [],
    identifier: null,
  })
}

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, fromResource, ResourceType, Schema }

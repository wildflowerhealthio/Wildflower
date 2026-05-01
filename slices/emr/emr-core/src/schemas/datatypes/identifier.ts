import { registerDatatypeSchema } from '../datatype-registry.ts'
import {
  IdentifierResourceType as ResourceType,
  IdentifierSchema as Schema,
  IdentifierUse,
} from './identifier-and-reference.ts'

registerDatatypeSchema(ResourceType, Schema)

export { IdentifierUse, ResourceType, Schema }

import { Datatype as makeDatatype } from '../datatype.ts'
import {
  IdentifierResourceType as ResourceType,
  IdentifierSchema as Schema,
  IdentifierUse,
} from './identifier-and-reference.ts'

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, IdentifierUse, ResourceType, Schema }

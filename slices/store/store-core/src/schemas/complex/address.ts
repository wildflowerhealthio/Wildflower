import { Schema } from 'effect'

import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'Address' as const
type ResourceType = typeof ResourceType

/**
 * The purpose of this address.
 * home | work | temp | old | billing - purpose of this address
 */
const UseSchema = Schema.Union(
  Schema.Literal('home'),
  Schema.Literal('work'),
  Schema.Literal('temp'),
  Schema.Literal('old'),
  Schema.Literal('billing')
)
type Use = typeof UseSchema.Type

/**
 * Distinguishes between physical addresses (those you can visit) and mailing addresses (e.g. PO Boxes and care-of addresses). Most addresses are both.
 * postal | physical | both
 */
const TypeSchema = Schema.Union(
  Schema.Literal('postal'),
  Schema.Literal('physical'),
  Schema.Literal('both')
)
type Type = typeof TypeSchema.Type

const fields = {
  use: Schema.NullOr(UseSchema),
  type: Schema.NullOr(TypeSchema),
  /**
   * Specifies the entire address as it should be displayed e.g. on a postal label. This may be provided instead of or as well as the specific parts.
   */
  text: Schema.NullOr(Schema.String),
  /**
   * This component contains the house number, apartment number, street name, street direction, P.O. Box number, delivery hints, and similar address information.
   */
  line: Schema.Array(Schema.String),
  /**
   * The name of the city, town, suburb, village or other community or delivery center.
   */
  city: Schema.NullOr(Schema.String),
  /**
   * The name of the administrative area (county).
   */
  district: Schema.NullOr(Schema.String),
  /**
   * Sub-unit of a country with limited sovereignty in a federally organized country. A code may be used if codes are in common use (e.g. US 2 letter state codes).
   */
  state: Schema.NullOr(Schema.String),
  /**
   * A postal code designating a region defined by the postal service.
   */
  postalCode: Schema.NullOr(Schema.String),
  /**
   * Country - a nation as commonly understood or generally accepted.
   */
  country: Schema.NullOr(Schema.String),
  /**
   * Time period when address was/is in use.
   */
  period: Schema.NullOr(PeriodSchema),
} as const satisfies Schema.Struct.Fields

/**
 * An address expressed using postal conventions
 * (as opposed to GPS or other location definition formats).
 */
const AddressSchema = Schema.Struct({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, AddressSchema)

export { Datatype, ResourceType, UseSchema, TypeSchema, AddressSchema as Schema }
export type { Use, Type }

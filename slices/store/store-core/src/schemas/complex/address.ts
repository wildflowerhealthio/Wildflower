import { Schema as ES } from 'effect'

import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'Address' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * The purpose of this address.
   * home | work | temp | old | billing - purpose of this address
   */
  use: ES.NullOr(
    ES.Union(
      ES.Literal('home'),
      ES.Literal('work'),
      ES.Literal('temp'),
      ES.Literal('old'),
      ES.Literal('billing')
    )
  ),
  /**
   * Distinguishes between physical addresses (those you can visit) and mailing addresses (e.g. PO Boxes and care-of addresses). Most addresses are both.
   * postal | physical | both
   */
  type: ES.NullOr(ES.Union(ES.Literal('postal'), ES.Literal('physical'), ES.Literal('both'))),
  /**
   * Specifies the entire address as it should be displayed e.g. on a postal label. This may be provided instead of or as well as the specific parts.
   */
  text: ES.NullOr(ES.String),
  /**
   * This component contains the house number, apartment number, street name, street direction, P.O. Box number, delivery hints, and similar address information.
   */
  line: ES.Array(ES.String),
  /**
   * The name of the city, town, suburb, village or other community or delivery center.
   */
  city: ES.NullOr(ES.String),
  /**
   * The name of the administrative area (county).
   */
  district: ES.NullOr(ES.String),
  /**
   * Sub-unit of a country with limited sovereignty in a federally organized country. A code may be used if codes are in common use (e.g. US 2 letter state codes).
   */
  state: ES.NullOr(ES.String),
  /**
   * A postal code designating a region defined by the postal service.
   */
  postalCode: ES.NullOr(ES.String),
  /**
   * Country - a nation as commonly understood or generally accepted.
   */
  country: ES.NullOr(ES.String),
  /**
   * Time period when address was/is in use.
   */
  period: ES.NullOr(PeriodSchema),
} as const satisfies ES.Struct.Fields

/**
 * An address expressed using postal conventions
 * (as opposed to GPS or other location definition formats).
 */
const Schema = ES.Struct({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }

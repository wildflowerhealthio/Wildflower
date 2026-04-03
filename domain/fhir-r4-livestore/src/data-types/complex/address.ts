import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'
import { Period } from './period.ts'

const ResourceType = 'Address'

const fields = {
  /**
   * The purpose of this address.
   * home | work | temp | old | billing - purpose of this address
   */
  use: Schema.UndefinedOr(
    Schema.Union(
      Schema.Literal('home'),
      Schema.Literal('work'),
      Schema.Literal('temp'),
      Schema.Literal('old'),
      Schema.Literal('billing')
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Distinguishes between physical addresses (those you can visit) and mailing addresses (e.g. PO Boxes and care-of addresses). Most addresses are both.
   * postal | physical | both
   */
  type: Schema.UndefinedOr(
    Schema.Union(Schema.Literal('postal'), Schema.Literal('physical'), Schema.Literal('both'))
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Specifies the entire address as it should be displayed e.g. on a postal label. This may be provided instead of or as well as the specific parts.
   */
  text: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * This component contains the house number, apartment number, street name, street direction, P.O. Box number, delivery hints, and similar address information.
   */
  line: Schema.Array(Schema.String).pipe(
    Schema.optionalWith({ default: () => [] as readonly string[] })
  ),
  /**
   * The name of the city, town, suburb, village or other community or delivery center.
   */
  city: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The name of the administrative area (county).
   */
  district: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Sub-unit of a country with limited sovereignty in a federally organized country. A code may be used if codes are in common use (e.g. US 2 letter state codes).
   */
  state: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * A postal code designating a region defined by the postal service.
   */
  postalCode: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Country - a nation as commonly understood or generally accepted.
   */
  country: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Time period when address was/is in use.
   */
  period: Schema.UndefinedOr(Schema.suspend(() => Period)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
} as const

const AddressElement = Element(ResourceType)

/** Encoded (wire-format) shape of an {@link Address}. */
export interface AddressEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<typeof ResourceType> {}

/**
 * An address expressed using postal conventions
 * (as opposed to GPS or other location definition formats).
 */
export class Address extends AddressElement.extend<Address>(ResourceType)(fields) {
  static readonly ResourceType = AddressElement.ResourceType
  static readonly IdSchema = AddressElement.IdSchema
}

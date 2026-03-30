import { Schema } from 'effect'

import { Period } from './period.ts'

const ResourceType = 'ContactPoint'

const fields = {
  /**
   * Telecommunications form for contact point - what communications system is required to make use of the contact.
   * phone | fax | email | pager | url | sms | other
   */
  system: Schema.optional(
    Schema.Union(
      Schema.Literal('phone'),
      Schema.Literal('fax'),
      Schema.Literal('email'),
      Schema.Literal('pager'),
      Schema.Literal('url'),
      Schema.Literal('sms'),
      Schema.Literal('other')
    )
  ),
  /**
   * The actual contact point details, in a form that is meaningful to the designated communication system (i.e. phone number or email address).
   */
  value: Schema.optional(Schema.String),
  /**
   * Identifies the purpose for the contact point.
   * home | work | temp | old | mobile - purpose of this contact point
   */
  use: Schema.optional(
    Schema.Union(
      Schema.Literal('home'),
      Schema.Literal('work'),
      Schema.Literal('temp'),
      Schema.Literal('old'),
      Schema.Literal('mobile')
    )
  ),
  /**
   * Specifies a preferred order in which to use a set of contacts. ContactPoints with lower rank values are more preferred than those with higher rank values.
   */
  rank: Schema.optional(Schema.Int),
  /**
   * Time period when the contact point was/is in use.
   */
  period: Schema.optional(Schema.suspend(() => Period)),
} as const

/** Encoded (wire-format) shape of a {@link ContactPoint}. */
export interface ContactPointEncoded extends Schema.Struct.Encoded<typeof fields> {}

/**
 * Details for all kinds of technology mediated contact points for a person or organization, including telephone, email, etc.
 */
export class ContactPoint extends Schema.Class<ContactPoint>(ResourceType)(fields) {
  static readonly ResourceType = ResourceType
}

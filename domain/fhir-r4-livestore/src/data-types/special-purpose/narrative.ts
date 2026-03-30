import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'

const ResourceType = 'Narrative' as const
type ResourceType = typeof ResourceType

const NarrativeStatus = Schema.Union(
  /**The contents of the narrative are entirely generated from the core elements in the content. */
  Schema.Literal('generated'),
  Schema.Literal('extensions'),
  Schema.Literal('additional'),
  Schema.Literal('empty')
)
type NarrativeStatus = typeof NarrativeStatus.Type

const fields = {
  status: NarrativeStatus,
  /**
   * Limited xhtml content
   * + Rule: The narrative SHALL contain only the basic html formatting
   * elements and attributes described in chapters 7-11 (except section 4 of
   * chapter 9) and 15 of the HTML 4.0 standard, <a> elements (either name or
   * href), images and internally contained style attributes, and SHALL contain
   * some non-whitespace characters
   */
  div: Schema.String,
} as const satisfies Schema.Struct.Fields

const NarrativeElement = Element(ResourceType)

/** Encoded (wire-format) shape of a {@link Narrative}. */
export interface NarrativeEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<ResourceType> {}

/**
 * Human-readable XHTML summary of a resource, with a `status` indicating
 * whether the narrative is generated, additional, or empty.
 */
export class Narrative extends NarrativeElement.extend<Narrative>(ResourceType)(fields) {
  static readonly ResourceType = ResourceType
  static readonly IdSchema = NarrativeElement.IdSchema
}

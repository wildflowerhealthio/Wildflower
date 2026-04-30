import { Schema as ES } from 'effect'

import { Schema as ElementSchema } from '../base/element.ts'

const ResourceType = 'Narrative' as const
type ResourceType = typeof ResourceType

const NarrativeStatus = ES.Union(
  /** The contents of the narrative are entirely generated from the core elements in the content. */
  ES.Literal('generated'),
  ES.Literal('extensions'),
  ES.Literal('additional'),
  ES.Literal('empty')
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
  div: ES.String,
} as const satisfies ES.Struct.Fields

/**
 * Human-readable XHTML summary of a resource, with a `status` indicating
 * whether the narrative is generated, additional, or empty.
 */
const Schema = ES.Struct({
  ...ElementSchema.fields,
  ...fields,
})

export { NarrativeStatus, ResourceType, Schema }

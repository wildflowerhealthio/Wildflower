import { Schema } from 'effect'

import { Schema as ElementSchema } from './element.ts'

const ResourceType = 'Narrative' as const
type ResourceType = typeof ResourceType

/**
 * FHIR R4 value set for `Narrative.status`:
 * - `generated` — the contents of the narrative are entirely generated from the core elements in the content
 * - `extensions` — additionally contains extensions from FHIR resources
 * - `additional` — additional information beyond the structured data
 * - `empty` — the narrative is empty (e.g., the resource has no narrative)
 */
const StatusSchema = Schema.Union(
  Schema.Literal('generated'),
  Schema.Literal('extensions'),
  Schema.Literal('additional'),
  Schema.Literal('empty')
)
type Status = typeof StatusSchema.Type

const fields = {
  status: StatusSchema,
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

/**
 * Human-readable XHTML summary of a resource, with a `status` indicating
 * whether the narrative is generated, additional, or empty.
 */
const NarrativeSchema = Schema.Struct({
  ...ElementSchema.fields,
  ...fields,
})

export { ResourceType, NarrativeSchema as Schema, StatusSchema }
export type { Status }

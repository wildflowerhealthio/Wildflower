import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Code } from './code.ts'
import { Schema as ElementSchema } from './element.ts'

// ---------------------------------------------------------------------------
// Coding
// ---------------------------------------------------------------------------

const ResourceType = 'Coding' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * A symbol in syntax defined by the system. The symbol may be a predefined code or an expression in a syntax defined by the coding system (e.g. post-coordination).
   */
  code: Schema.NullOr(Code),
  /**
   * A representation of the meaning of the code in the system, following the rules of the system.
   */
  display: Schema.NullOr(Schema.String),
  /**
   * The URI may be an OID (urn:oid:...) or a UUID (urn:uuid:...).
   * Per FHIR R4 § Coding, `system` is a URI; absolute URIs (including the
   * `urn:oid:` and `urn:uuid:` schemes) parse via the URL constructor.
   */
  system: Schema.NullOr(Schema.URL),
  /**
   * Amongst a set of alternatives, a directly chosen code is the most appropriate starting point for new translations.
   */
  userSelected: Schema.NullOr(Schema.Boolean),
  /**
   * Version of the terminology definition.
   */
  version: Schema.NullOr(Schema.String),
} as const satisfies FieldsNoContext

/**
 * A reference to a code defined by a terminology system. Binds a `code` to
 * a `system` URI and optional `display` text.
 */
const CodingSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, CodingSchema)

/**
 * Construct a Coding with a const-narrowed return type — useful for literals
 * whose `code`/`system`/`display` values are meant to be exact types.
 */
const makeLiteral = <const C extends Parameters<typeof CodingSchema.make>[0]>(
  params: C
): Schema.Schema.Type<typeof CodingSchema> & C =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Schema.make` widens the const-narrowed `params` to the schema's full Type; the cast restores the caller-visible literal narrowing.
  CodingSchema.make(params) as Schema.Schema.Type<typeof CodingSchema> & C

export { CodingSchema as Schema, makeLiteral, ResourceType }

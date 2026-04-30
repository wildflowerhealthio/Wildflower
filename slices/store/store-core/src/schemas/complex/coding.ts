import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Code } from './code.ts'

// ---------------------------------------------------------------------------
// Coding
// ---------------------------------------------------------------------------

const ResourceType = 'Coding' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * A symbol in syntax defined by the system. The symbol may be a predefined code or an expression in a syntax defined by the coding system (e.g. post-coordination).
   */
  code: ES.NullOr(Code),
  /**
   * A representation of the meaning of the code in the system, following the rules of the system.
   */
  display: ES.NullOr(ES.String),
  /**
   * The URI may be an OID (urn:oid:...) or a UUID (urn:uuid:...).
   */
  system: ES.NullOr(ES.String),
  /**
   * Amongst a set of alternatives, a directly chosen code is the most appropriate starting point for new translations.
   */
  userSelected: ES.NullOr(ES.Boolean),
  /**
   * Version of the terminology definition.
   */
  version: ES.NullOr(ES.String),
} as const satisfies FieldsNoContext

/**
 * A reference to a code defined by a terminology system. Binds a `code` to
 * a `system` URI and optional `display` text.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

/** Encoded (wire-format) shape of a Coding. */
interface CodingEncoded
  extends ES.Struct.Encoded<typeof fields>, ES.Schema.Encoded<typeof ElementSchema> {}

const Datatype = makeDatatype(ResourceType, Schema)

/**
 * Construct a Coding with a const-narrowed return type — useful for literals
 * whose `code`/`system`/`display` values are meant to be exact types.
 */
const makeLiteral = <const C extends Parameters<typeof Schema.make>[0]>(
  params: C
): ES.Schema.Type<typeof Schema> & C =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Schema.make(params) as ES.Schema.Type<typeof Schema> & C

export { Datatype, makeLiteral, ResourceType, Schema }
export type { CodingEncoded }

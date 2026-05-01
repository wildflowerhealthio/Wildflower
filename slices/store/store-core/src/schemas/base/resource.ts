import { Schema } from 'effect'

import { State } from '@livestore/common/schema'
import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Code } from '../datatypes/code.ts'
import { Schema as MetaSchema } from '../datatypes/meta.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded shape of a FHIR Resource — the base type for all resources.
 * Includes only the four fields defined on FHIR R4 Resource:
 * `id`, `meta`, `implicitRules`, `language`.
 *
 * @typeParam TResourceType - The literal domain type string (e.g. `'Patient'`)
 */

const fields = {
  meta: Schema.NullOr(MetaSchema),
  implicitRules: Schema.NullOr(Schema.URL),
  language: Schema.NullOr(Code),
} as const satisfies FieldsNoContext

const columns = {
  meta: State.SQLite.json({
    nullable: true,
    schema: MetaSchema,
  }),
  implicitRules: State.SQLite.text({
    nullable: true,
    schema: Schema.URL,
  }),
  language: State.SQLite.text({
    nullable: true,
    schema: Code,
  }),
} as const

const ResourceSchema = StructNoContext(fields)

export { ResourceSchema as Schema, fields, columns }

import { Arbitrary, type FastCheck, Schema } from 'effect'

import { Base64FromUint8ArrayBuffer, type FieldsNoContext } from 'kitchen-sink/schema'

import { State } from '@livestore/livestore'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import * as DomainResource from '../livestore/domain-resource.ts'
import { Code } from '../schemas/complex/code.ts'
import * as Reference from '../schemas/complex/reference.ts'

const resourceType = 'Binary' as const

const fields = {
  resourceType: Schema.Literal(resourceType),
  /**
   * MimeType of the binary content represented as a standard MimeType (BCP 13).
   */
  contentType: Code,
  /**
   * The actual content, base64 encoded.
   */
  data: Schema.NullOr(Schema.String),
  /**
   * Identifies another resource to use as proxy when enforcing access control
   * on the Binary resource.
   */
  securityContext: Schema.NullOr(Reference.Schema),
} as const satisfies FieldsNoContext

const columns = {
  ...DomainResource.columns,
  resourceType: State.SQLite.text({
    default: resourceType,
    schema: Schema.Literal(resourceType),
  }),
  id: State.SQLite.text({ primaryKey: true }),
  contentType: State.SQLite.text({ schema: Code }),
  data: State.SQLite.blob({
    nullable: true,
    schema: Base64FromUint8ArrayBuffer,
  }),
  securityContext: State.SQLite.json({
    nullable: true,
    schema: Reference.Schema,
  }),
} as const

const table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema: BaseRowSchema, RowSchemaOptionalId } = makeRowSchemas(columns, {
  name: resourceType,
})

// Normalize the `data` column's arbitrary values through the base64 encode
// of a freshly-generated `Uint8Array`, so property tests round-trip without
// tripping over strings that don't decode.
const RowSchema = BaseRowSchema.annotations({
  arbitrary: () => (fc: typeof FastCheck) =>
    Arbitrary.make(BaseRowSchema).chain((binary) =>
      fc.uint8Array().map((data) => ({
        ...binary,
        data: Schema.encodeSync(Schema.Uint8ArrayFromBase64)(data),
      }))
    ),
})

export { resourceType, fields, table, RowSchema, RowSchemaOptionalId }

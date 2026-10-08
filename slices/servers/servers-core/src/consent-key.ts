import { Schema } from 'effect'

/**
 * One consent on a server, by the key its flow looks it up by: a device's
 * pairing by its `userCode`, an app's `/authorize` by its request `id`.
 */
const ConsentKeySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('device'), userCode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('oauth'), id: Schema.String })
)

/** A decoded {@link ConsentKeySchema}. */
type Type = typeof ConsentKeySchema.Type

/** A stable string for `key`, distinct across the two flows: a React key, or a "handled" marker. */
const asString = (key: Type): string =>
  key.kind === 'device' ? `device:${key.userCode}` : `oauth:${key.id}`

export { asString, ConsentKeySchema as Schema }
export type { Type }

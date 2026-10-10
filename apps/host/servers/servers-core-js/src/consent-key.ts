import { Schema } from 'effect'

import type * as ConsentDetails from './consent-details.ts'

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

/** The key the consent `details` describe is looked up by. */
const of = (details: ConsentDetails.Type): Type =>
  details.kind === 'device'
    ? { kind: 'device', userCode: details.userCode }
    : { kind: 'oauth', id: details.id }

export { asString, ConsentKeySchema as Schema, of }
export type { Type }

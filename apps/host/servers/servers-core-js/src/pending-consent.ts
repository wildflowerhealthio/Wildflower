import { Schema } from 'effect'

/**
 * The newest consent waiting for the Owner on a server, as a running
 * server's status carries it: which request, by the key its page looks it up
 * by (a device's pairing by its `userCode`, an app's `/authorize` by its
 * request `id`), and the name of the client that asks, its registered name or
 * else its `client_id`.
 */
const PendingConsentSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('device'),
    userCode: Schema.String,
    clientName: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('oauth'), id: Schema.String, clientName: Schema.String })
)

/** A decoded {@link PendingConsentSchema}. */
type Type = typeof PendingConsentSchema.Type

/** A string naming the request, distinct across the two flows: a React key. */
const keyOf = (pendingConsent: Type): string =>
  pendingConsent.kind === 'device'
    ? `device:${pendingConsent.userCode}`
    : `oauth:${pendingConsent.id}`

export { keyOf, PendingConsentSchema as Schema }
export type { Type }

import { Option, Schema } from 'effect'

import * as ConsentKey from './consent-key.ts'

/**
 * The oldest consent waiting for the Owner on one server, as
 * `pending_consents_list` and the {@link EVENT} carry it: `head` is absent
 * once nothing waits there, as when the server stops.
 */
const PendingConsentSchema = Schema.Struct({
  domain: Schema.String,
  head: Schema.optionalWith(ConsentKey.Schema, { as: 'Option', exact: true }),
})

/** A decoded {@link PendingConsentSchema}. */
type Type = typeof PendingConsentSchema.Type

/**
 * The Tauri event the host emits a server's pending consent on, to the
 * base's webview, whenever the oldest consent waiting there changes: one
 * event per server.
 */
const EVENT = 'pending-consent'

/** Decode an {@link EVENT}'s payload, as it arrives in the event's callback. */
const decodeEvent = Schema.decodeUnknownEither(PendingConsentSchema)

/** A consent waiting on one server: the server's domain and the consent's key. */
interface Waiting {
  readonly domain: string
  readonly key: ConsentKey.Type
}

/**
 * `waiting` with `pendingConsent` in place of the same server's: a server
 * keeps its place as its head moves on, a server new to the queue joins its
 * end, and a server is dropped once nothing waits there.
 */
const withPendingConsent = (
  waiting: readonly Waiting[],
  pendingConsent: Type
): readonly Waiting[] => {
  const { domain } = pendingConsent
  return Option.match(pendingConsent.head, {
    onNone: () => waiting.filter((entry) => entry.domain !== domain),
    onSome: (key): readonly Waiting[] =>
      waiting.some((entry) => entry.domain === domain)
        ? waiting.map((entry) => (entry.domain === domain ? { domain, key } : entry))
        : [...waiting, { domain, key }],
  })
}

/** The consents `pending_consents_list` answered with, one per server with one waiting. */
const waitingOf = (pendingConsents: readonly Type[]): readonly Waiting[] =>
  pendingConsents.reduce<readonly Waiting[]>(withPendingConsent, [])

export { decodeEvent, EVENT, PendingConsentSchema as Schema, waitingOf, withPendingConsent }
export type { Type, Waiting }

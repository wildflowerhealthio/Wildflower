import { Match, Schema } from 'effect'

/**
 * The newest consent waiting for the Owner on a server, as a running
 * server's status carries it: which request, by the key its page looks it up
 * by (a device's pairing or a browser's by its `userCode`, an app's
 * `/authorize` or a browser's ask to widen its session by its `id`), and the
 * name of what asks: for a device or an app, its client's registered name or
 * else its `client_id`; for a browser, the browser's name. A browser is always
 * remote: the Owner's own browser signs in on the server's device instead.
 */
const PendingConsentSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('device'),
    userCode: Schema.String,
    requesterName: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('oauth'), id: Schema.String, requesterName: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('browser'),
    userCode: Schema.String,
    requesterName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('widening'),
    id: Schema.String,
    requesterName: Schema.String,
  })
)

/** A decoded {@link PendingConsentSchema}. */
type Type = typeof PendingConsentSchema.Type

/** A string naming the request, distinct across its kinds: a React key. */
const keyOf = (pendingConsent: Type): string =>
  Match.value(pendingConsent).pipe(
    Match.when({ kind: 'device' }, ({ userCode }) => `device:${userCode}`),
    Match.when({ kind: 'oauth' }, ({ id }) => `oauth:${id}`),
    Match.when({ kind: 'browser' }, ({ userCode }) => `browser:${userCode}`),
    Match.when({ kind: 'widening' }, ({ id }) => `widening:${id}`),
    Match.exhaustive
  )

/** What the request asks, in a sentence naming what asks. */
const askOf = (pendingConsent: Type): string =>
  Match.value(pendingConsent).pipe(
    Match.when(
      { kind: 'browser' },
      ({ requesterName }) => `${requesterName}, a remote browser, wants to sign in.`
    ),
    Match.when(
      { kind: 'widening' },
      ({ requesterName }) => `${requesterName}, a remote browser, wants more access.`
    ),
    Match.orElse(({ requesterName }) => `${requesterName} wants access.`)
  )

export { askOf, keyOf, PendingConsentSchema as Schema }
export type { Type }

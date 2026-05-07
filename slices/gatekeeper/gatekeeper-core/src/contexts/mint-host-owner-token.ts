import { type Duration, Effect } from 'effect'
import { UnknownException } from 'effect/Cause'
import { Origin } from 'kitchen-sink'
import { mintAccessToken } from '../internal/jwt.ts'
import { SigningKey } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'
import { FIRST_PARTY_CLIENT_ID } from './seed-first-party-client.ts'

/**
 * Mint an Owner-scoped access token for the first-party host client.
 *
 * Dev-mode bootstrap helper for processes that have direct access to the
 * gatekeeper store (wildflower-node, native shell, dev server, CLI login).
 * The host can sign a token for itself and surface it on the SPA's
 * `?token=` query param, so an operator opening the app lands authenticated
 * without going through the device-flow handshake. **Not a production
 * pattern** — the long-term first-Owner story is unsettled; until then this
 * lives behind a dev gate at the call site.
 *
 * `ttl` is required because the right value depends on context the minter
 * has and this helper does not (dev-server lifetime, CI run length, native
 * shell first-launch grace window). No silent default; the caller picks.
 *
 * Picks the active signing key when one is flagged, otherwise the first
 * key in the store. Caller should run `seedFirstPartyClient` first — the
 * token only fails verification later if `wildflower-host` is missing or
 * disabled.
 */
const mintHostOwnerToken = (options: {
  readonly ttl: Duration.Duration
}): Effect.Effect<string, UnknownException, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const origin = yield* Origin
    const active = store.query(SigningKey.queries.active$)
    const all = store.query(SigningKey.queries.all$)
    const signingKey = active ?? all[0]
    if (signingKey === undefined) {
      return yield* Effect.fail(
        new UnknownException('mintHostOwnerToken: no signing keys in the store')
      )
    }
    return yield* mintAccessToken(signingKey, origin, {
      clientId: FIRST_PARTY_CLIENT_ID,
      scope: ['owner'],
      ttl: options.ttl,
    })
  })

export { mintHostOwnerToken }

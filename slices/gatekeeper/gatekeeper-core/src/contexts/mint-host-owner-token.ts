import { type Duration, Effect } from 'effect'
import { UnknownException } from 'effect/Cause'
import { Origin } from 'navigation-core'
import { mintAccessToken } from '../internal/jwt.ts'
import { GatekeeperStore, SigningKey } from '../livestore/index.ts'
import { FIRST_PARTY_CLIENT_ID } from './seed-first-party-client.ts'
/**
 * Mint an Owner-scoped access token for the first-party host client.
 *
 * @remarks
 * Dev-mode bootstrap helper for processes with direct gatekeeper-store
 * access. **Not a production pattern** — gate behind a dev check at the
 * call site. `ttl` has no default because the right value is context-
 * dependent (dev server lifetime, CI run length, etc.). Picks the active
 * signing key, falling back to the first available; caller should run
 * `seedFirstPartyClient` first.
 *
 * @see [README — Bootstrap URL](../../README.md)
 */
const mintHostOwnerToken = (options: {
  readonly ttl: Duration.Duration
}): Effect.Effect<string, UnknownException, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const origin = yield* Origin.get
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

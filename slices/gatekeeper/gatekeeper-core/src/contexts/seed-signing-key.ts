import { Array, Effect } from 'effect'
import { SigningKey } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

/**
 * Idempotently ensure the gatekeeper store has at least one active
 * signing key. Designed to be invoked once after the LiveStore is
 * available — alongside `seedFirstPartyClient`. No-op if a key already
 * exists. Fresh stores get a new RSA-2048 key, committed via
 * `signingKeyAdded` + `signingKeyActivated` so `SigningKey.queries.active$`
 * resolves (the materialiser sets `isActive: false` on `signingKeyAdded`
 * alone, so without the activation the active query stays empty
 * forever and sign-side callers fall through to `all[0]`).
 */
const seedSigningKey: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(function* () {
  const store = yield* GatekeeperStore
  const signingKeys = store.query(SigningKey.queries.all$)
  if (Array.isNonEmptyReadonlyArray(signingKeys)) return
  const signingKey = yield* Effect.promise(() => SigningKey.generate())
  store.commit(
    SigningKey.events.signingKeyAdded({ signingKey }),
    SigningKey.events.signingKeyActivated({ kid: signingKey.kid })
  )
})

export { seedSigningKey }

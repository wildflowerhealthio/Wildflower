import { Array, Effect } from 'effect'
import { GatekeeperStore, SigningKey } from '../livestore/index.ts'
/**
 * Idempotently ensure the gatekeeper store has at least one active
 * signing key. No-op if a key already exists; fresh stores get a new
 * RSA-2048 key.
 *
 * @remarks
 * Commits both `signingKeyAdded` and `signingKeyActivated`. Without the
 * activation event, `SigningKey.queries.active$` stays empty (the
 * materialiser flags `isActive: false` on `signingKeyAdded` alone), and
 * sign-side callers fall through to `all[0]`.
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

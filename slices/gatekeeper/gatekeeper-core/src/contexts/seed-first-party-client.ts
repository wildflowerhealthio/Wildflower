import { DateTime, Effect } from 'effect'
import { Clients } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const FIRST_PARTY_CLIENT_ID = 'wildflower-host'

/**
 * Idempotently register the host's first-party Owner client. Designed to
 * be invoked once after the LiveStore is available — call it directly,
 * don't wrap in a Layer (the call site knows when the store is ready
 * and whether to await the effect).
 */
const seedFirstPartyClient: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(function* () {
  const store = yield* GatekeeperStore
  const existing = store.query(Clients.queries.byId$(FIRST_PARTY_CLIENT_ID))
  if (existing != null) {
    return
  }
  const registeredAt = yield* DateTime.now
  store.commit(
    Clients.events.clientRegistered({
      clientId: FIRST_PARTY_CLIENT_ID,
      name: 'Wildflower (host)',
      kind: 'public',
      redirectUris: [],
      allowedScopes: ['owner'],
      secretHash: null,
      registeredAt,
    })
  )
})

export { FIRST_PARTY_CLIENT_ID, seedFirstPartyClient }

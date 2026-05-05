import { DateTime, Effect, Layer } from 'effect'
import { Clients } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const FIRST_PARTY_CLIENT_ID = 'wildflower-host'

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

const SeedFirstPartyClientLive = Layer.effectDiscard(seedFirstPartyClient)

export { FIRST_PARTY_CLIENT_ID, seedFirstPartyClient, SeedFirstPartyClientLive }

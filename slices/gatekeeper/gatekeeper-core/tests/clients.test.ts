import { DateTime, Effect, Schema } from 'effect'
import { expect, test } from 'vite-plus/test'
import type { GatekeeperStore } from '../src/contexts/gatekeeper-store.ts'
import { makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import {
  FIRST_PARTY_CLIENT_ID,
  seedFirstPartyClient,
} from '../src/contexts/seed-first-party-client.ts'
import { Clients, type ClientRow } from '../src/livestore/index.ts'

const decodeClientRegisteredArgs = Schema.decodeUnknownSync(Clients.events.clientRegistered.schema)

const labelOf = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'label' in q && typeof q.label === 'string') {
    return q.label
  }
  return undefined
}
const hashOf = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

type Committed = { name: string; args: Record<string, unknown> }

const makeFakeStore = (
  initial: ReadonlyArray<ClientRow> = []
): { store: typeof GatekeeperStore.Service; committed: Committed[] } => {
  const clientMap = new Map(initial.map((c) => [c.clientId, c]))
  const committed: Committed[] = []

  const query = (q: unknown): unknown => {
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientMap.keys()) {
        if (Clients.queries.byId$(clientId).hash === hash) {
          return clientMap.get(clientId) ?? null
        }
      }
      return null
    }
    return []
  }

  const commit = (...events: ReadonlyArray<Committed>): void => {
    committed.push(...events)
    for (const event of events) {
      if (event.name === 'v1.ClientRegistered') {
        const args = decodeClientRegisteredArgs(event.args)
        clientMap.set(args.clientId, { ...args, disabledAt: null })
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { store: { query, commit } as unknown as typeof GatekeeperStore.Service, committed }
}

test('Clients events expose registered, updated, disabled', () => {
  expect(typeof Clients.events.clientRegistered).toBe('function')
  expect(typeof Clients.events.clientUpdated).toBe('function')
  expect(typeof Clients.events.clientDisabled).toBe('function')
})

test('Clients.queries.byId$ has a stable hash that distinguishes by id', () => {
  const a = Clients.queries.byId$('client-a').hash
  const b = Clients.queries.byId$('client-b').hash
  const aAgain = Clients.queries.byId$('client-a').hash
  expect(a).toBe(aAgain)
  expect(a).not.toBe(b)
})

test('seedFirstPartyClient commits clientRegistered when no client exists', async () => {
  const { store, committed } = makeFakeStore([])
  await Effect.runPromise(
    seedFirstPartyClient.pipe(Effect.provide(makeGatekeeperStoreLayer(store)))
  )
  expect(committed.map((e) => e.name)).toEqual(['v1.ClientRegistered'])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const args = committed[0]?.args as { clientId: string; allowedScopes: ReadonlyArray<string> }
  expect(args.clientId).toBe(FIRST_PARTY_CLIENT_ID)
  expect(args.allowedScopes).toEqual(['owner'])
})

test('seedFirstPartyClient is a no-op when wildflower-host is already registered', async () => {
  const existing: ClientRow = {
    clientId: FIRST_PARTY_CLIENT_ID,
    name: 'Wildflower (host)',
    kind: 'public',
    redirectUris: [],
    allowedScopes: ['owner'],
    secretHash: null,
    registeredAt: DateTime.unsafeNow(),
    disabledAt: null,
  }
  const { store, committed } = makeFakeStore([existing])
  await Effect.runPromise(
    seedFirstPartyClient.pipe(Effect.provide(makeGatekeeperStoreLayer(store)))
  )
  expect(committed).toEqual([])
})

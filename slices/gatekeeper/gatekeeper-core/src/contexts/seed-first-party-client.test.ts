import { DateTime, Effect } from 'effect'
import { expect, test } from 'vite-plus/test'
import { Client, type ClientRow, GatekeeperStore } from '../livestore/index.ts'
import { FIRST_PARTY_CLIENT_ID, seedFirstPartyClient } from './seed-first-party-client.ts'
// Event factories pass args through in their decoded form (e.g.
// `registeredAt` is `DateTime.Utc`, not the encoded ISO string).
// Re-decoding with `Schema.decodeUnknownSync` would reject the value
// for the encoded-side mismatch, so we just cast — the schema check
// already happened when `events.clientRegistered({...})` was called.
type ClientRegisteredArgs = typeof Client.events.clientRegistered.schema.Type

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
        if (Client.queries.byId$(clientId).hash === hash) {
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const args = event.args as unknown as ClientRegisteredArgs
        clientMap.set(args.clientId, { ...args, disabledAt: null })
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { store: { query, commit } as unknown as typeof GatekeeperStore.Service, committed }
}

test('Client events expose registered, updated, disabled', () => {
  expect(typeof Client.events.clientRegistered).toBe('function')
  expect(typeof Client.events.clientUpdated).toBe('function')
  expect(typeof Client.events.clientDisabled).toBe('function')
})

test('Client.queries.byId$ has a stable hash that distinguishes by id', () => {
  const a = Client.queries.byId$('client-a').hash
  const b = Client.queries.byId$('client-b').hash
  const aAgain = Client.queries.byId$('client-a').hash
  expect(a).toBe(aAgain)
  expect(a).not.toBe(b)
})

test('seedFirstPartyClient commits clientRegistered when no client exists', async () => {
  const { store, committed } = makeFakeStore([])
  await Effect.runPromise(
    seedFirstPartyClient.pipe(Effect.provide(GatekeeperStore.layerFrom(store)))
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
    seedFirstPartyClient.pipe(Effect.provide(GatekeeperStore.layerFrom(store)))
  )
  expect(committed).toEqual([])
})

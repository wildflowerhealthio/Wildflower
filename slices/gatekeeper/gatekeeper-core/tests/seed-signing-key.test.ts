import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Effect } from 'effect'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { seedSigningKey } from '../src/contexts/seed-signing-key.ts'
import { schema, SigningKey } from '../src/livestore/index.ts'

let store: Store<typeof schema, object>

beforeEach(async () => {
  store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `seed-signing-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
})

afterEach(async () => {
  await store.shutdownPromise().catch(() => undefined)
})

test('seedSigningKey commits both signingKeyAdded and signingKeyActivated on a fresh store', async () => {
  await Effect.runPromise(seedSigningKey.pipe(Effect.provide(makeGatekeeperStoreLayer(store))))
  const keys = store.query(SigningKey.queries.all$)
  expect(keys).toHaveLength(1)
  // Activation makes the active query resolve to a value, not null.
  const active = store.query(SigningKey.queries.active$)
  expect(active).not.toBeNull()
  expect(active?.kid).toBe(keys[0]?.kid)
})

test('seedSigningKey is a no-op on a store that already has a key', async () => {
  await Effect.runPromise(seedSigningKey.pipe(Effect.provide(makeGatekeeperStoreLayer(store))))
  const firstKey = store.query(SigningKey.queries.active$)
  expect(firstKey).not.toBeNull()
  await Effect.runPromise(seedSigningKey.pipe(Effect.provide(makeGatekeeperStoreLayer(store))))
  const keys = store.query(SigningKey.queries.all$)
  expect(keys).toHaveLength(1)
  const active = store.query(SigningKey.queries.active$)
  expect(active?.kid).toBe(firstKey?.kid)
})

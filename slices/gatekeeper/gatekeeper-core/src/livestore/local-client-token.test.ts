import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'
import { describe, expect, it } from 'vite-plus/test'

import { events, LocalClientToken, schema } from './index.ts'

describe('LocalClientToken.queries.current$', () => {
  it('materializes the default row (value: null) on first read of a fresh store', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    try {
      expect(store.query(LocalClientToken.queries.current$)).toEqual({ value: null })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('round-trips a committed token value back through the live query', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    try {
      store.commit(events.localClientTokenSet({ value: 'jwt.local.client.token' }))
      expect(store.query(LocalClientToken.queries.current$)).toEqual({
        value: 'jwt.local.client.token',
      })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('rotates the row when a new value is committed mid-session', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    try {
      store.commit(events.localClientTokenSet({ value: 'first' }))
      store.commit(events.localClientTokenSet({ value: 'second' }))
      expect(store.query(LocalClientToken.queries.current$)).toEqual({ value: 'second' })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

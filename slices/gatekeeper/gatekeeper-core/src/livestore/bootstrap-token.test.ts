import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'
import { describe, expect, it } from 'vite-plus/test'

import { BootstrapToken, events, schema } from './index.ts'

describe('BootstrapToken.queries.current$', () => {
  it('materializes the default row (token: null) on first read of a fresh store', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    try {
      expect(store.query(BootstrapToken.queries.current$)).toEqual({ token: null })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('round-trips a committed token back through the live query', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    try {
      store.commit(events.bootstrapTokenSet({ token: 'jwt.bootstrap.token' }))
      expect(store.query(BootstrapToken.queries.current$)).toEqual({
        token: 'jwt.bootstrap.token',
      })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

/**
 * Sanity check: does `store.query(ServerState.queries.current$)` materialize
 * the clientDocument default row on a brand-new store?
 */
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'
import { LogLevel } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { schema, ServerState } from './index.ts'

describe('ServerState.queries.current$', () => {
  it('materializes the default row on first read of a fresh store', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // LiveStore defaults to LogLevel.Debug in a non-production env, emitting
      // a `LiveStore shutdown complete` line on teardown. Pin to Info to keep
      // genuine warnings/errors visible without the debug noise.
      logLevel: LogLevel.Info,
    })
    try {
      const result = store.query(ServerState.queries.current$)
      expect(result).toMatchObject({
        requestedRunning: false,
        running: false,
        port: 8080,
        localHostname: '127.0.0.1',
      })
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

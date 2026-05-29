import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, State } from '@livestore/livestore'
import { LogLevel } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as LocalHttpServerLivestore from './index.ts'
import { localOrigin$ } from './local-origin.ts'

const composedSchema = (() => {
  const tables = { ...LocalHttpServerLivestore.tables }
  const events = { ...LocalHttpServerLivestore.events }
  const materializers = State.SQLite.materializers(events, {
    ...LocalHttpServerLivestore.materializers,
  })
  return makeSchema({
    events,
    state: State.SQLite.makeState({ tables, materializers }),
  })
})()

const makeStore = (): ReturnType<typeof createStorePromise<typeof composedSchema>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema: composedSchema,
    storeId: `local-origin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    // LiveStore defaults to LogLevel.Debug in a non-production env, emitting
    // a `LiveStore shutdown complete` line on teardown. Pin to Info to keep
    // genuine warnings/errors visible without the debug noise.
    logLevel: LogLevel.Info,
  })

describe('localOrigin$', () => {
  it('returns the idle default loopback origin before the daemon has bound', async () => {
    const store = await makeStore()
    try {
      expect(store.query(localOrigin$)).toBe('http://127.0.0.1:8080')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('reflects the bound hostname and port committed by the daemon', async () => {
    const store = await makeStore()
    try {
      store.commit(
        LocalHttpServerLivestore.ServerState.events.localHttpServerStateSet({
          localHostname: '0.0.0.0',
          port: 4242,
        })
      )
      expect(store.query(localOrigin$)).toBe('http://0.0.0.0:4242')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, State } from '@livestore/livestore'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import { describe, expect, it } from 'vite-plus/test'

import * as TunnelLivestore from './index.ts'
import { servedOrigin$ } from './served-origin.ts'

/**
 * `servedOrigin$` joins `TunnelState` and `ServerState` from two slices.
 * Real consumers compose both into an app-level schema; tests do the same
 * inline so the computed query can resolve.
 */
const composedSchema = (() => {
  const tables = {
    ...TunnelLivestore.tables,
    ...LocalHttpServerLivestore.tables,
  }
  const events = {
    ...TunnelLivestore.events,
    ...LocalHttpServerLivestore.events,
  }
  const materializers = State.SQLite.materializers(events, {
    ...TunnelLivestore.materializers,
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
    storeId: `served-origin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

describe('servedOrigin$', () => {
  it('falls back to the loopback origin when the tunnel is not running', async () => {
    const store = await makeStore()
    try {
      expect(store.query(servedOrigin$)).toBe('http://127.0.0.1:8080')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('uses the LHS-bound hostname and port in the fallback', async () => {
    const store = await makeStore()
    try {
      store.commit(
        LocalHttpServerLivestore.ServerState.events.localHttpServerStateSet({
          localHostname: '0.0.0.0',
          port: 4242,
        })
      )
      expect(store.query(servedOrigin$)).toBe('http://0.0.0.0:4242')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('returns the tunnel URL when the tunnel is running with a bound subdomain and root', async () => {
    const store = await makeStore()
    try {
      store.commit(
        TunnelLivestore.TunnelState.events.tunnelStateSet({
          running: true,
          currentSubdomain: 'feather',
          currentRootDomain: 'loca.lt',
          currentLocalPort: 8080,
        })
      )
      expect(store.query(servedOrigin$)).toBe('https://feather.loca.lt')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('falls through to loopback when the tunnel is running but currentRootDomain is empty', async () => {
    const store = await makeStore()
    try {
      // Some relays return a single-label hostname; `parseGrantedDomain`
      // in `tunnel-expo/src/startTunnel.ts` reports root as ''. That
      // should count as unbound.
      store.commit(
        TunnelLivestore.TunnelState.events.tunnelStateSet({
          running: true,
          currentSubdomain: 'feather',
          currentRootDomain: '',
          currentLocalPort: 8080,
        })
      )
      expect(store.query(servedOrigin$)).toBe('http://127.0.0.1:8080')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('falls through to loopback when running flips false even with bound names', async () => {
    const store = await makeStore()
    try {
      store.commit(
        TunnelLivestore.TunnelState.events.tunnelStateSet({
          running: false,
          currentSubdomain: 'feather',
          currentRootDomain: 'loca.lt',
          currentLocalPort: 8080,
        })
      )
      expect(store.query(servedOrigin$)).toBe('http://127.0.0.1:8080')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

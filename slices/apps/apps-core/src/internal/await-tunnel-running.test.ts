import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Duration, Effect } from 'effect'
import { schema, TunnelState, TunnelStore } from 'tunnel-core/livestore'
import { describe, expect, it } from 'vite-plus/test'

import { awaitTunnelRunning } from './await-tunnel-running.ts'

const makeStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `await-tunnel-running-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

describe('awaitTunnelRunning', () => {
  it('returns timed-out when the daemon never flips running=true within the deadline', async () => {
    const store = await makeStore()
    try {
      const outcome = await Effect.runPromise(
        awaitTunnelRunning(Duration.millis(50)).pipe(Effect.provide(TunnelStore.layerFrom(store)))
      )
      expect(outcome.kind).toBe('timed-out')
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('returns running immediately when the current snapshot already has running=true', async () => {
    const store = await makeStore()
    try {
      store.commit(
        TunnelState.events.tunnelStateSet({
          running: true,
          currentSubdomain: 'sub',
          currentRootDomain: 'example.com',
          currentLocalPort: 8787,
        })
      )
      const outcome = await Effect.runPromise(
        awaitTunnelRunning(Duration.seconds(5)).pipe(Effect.provide(TunnelStore.layerFrom(store)))
      )
      expect(outcome.kind).toBe('running')
      if (outcome.kind === 'running') {
        expect(outcome.state.currentSubdomain).toBe('sub')
        expect(outcome.state.currentRootDomain).toBe('example.com')
        expect(outcome.state.currentLocalPort).toBe(8787)
      }
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

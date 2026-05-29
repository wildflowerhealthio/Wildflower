import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Cause, Duration, Effect, Exit, LogLevel } from 'effect'
import { schema, TunnelState, TunnelStore } from 'tunnel-core/livestore'
import { describe, expect, it } from 'vite-plus/test'

import { awaitTunnelRunning, TunnelLaunchTimedOut } from './await-tunnel-running.ts'

const makeStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `await-tunnel-running-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    // LiveStore defaults to LogLevel.Debug in a non-production env, emitting
    // a `LiveStore shutdown complete` line on teardown. Pin to Info to keep
    // genuine warnings/errors visible without the debug noise.
    logLevel: LogLevel.Info,
  })

describe('awaitTunnelRunning', () => {
  it('fails with TunnelLaunchTimedOut when the daemon never flips running=true within the deadline', async () => {
    const store = await makeStore()
    try {
      const timeout = Duration.millis(50)
      const exit = await Effect.runPromiseExit(
        awaitTunnelRunning(timeout).pipe(Effect.provide(TunnelStore.layerFrom(store)))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value).toBeInstanceOf(TunnelLaunchTimedOut)
          expect(failure.value.timeoutMs).toBe(Duration.toMillis(timeout))
        }
      }
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('returns the RunningTunnel snapshot immediately when running=true is already set', async () => {
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
      const tunnel = await Effect.runPromise(
        awaitTunnelRunning(Duration.seconds(5)).pipe(Effect.provide(TunnelStore.layerFrom(store)))
      )
      expect(tunnel.currentSubdomain).toBe('sub')
      expect(tunnel.currentRootDomain).toBe('example.com')
      expect(tunnel.currentLocalPort).toBe(8787)
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

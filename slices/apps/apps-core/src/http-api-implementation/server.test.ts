import { HttpApiBuilder, HttpServer } from '@effect/platform'
import type { Store } from '@livestore/livestore'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { makeAppsStoreLayer } from '../contexts/apps-store.ts'
import {
  type ServerState,
  TunnelControl,
  TunnelUnavailable,
  type TunnelControlService,
} from '../contexts/tunnel-control.ts'
import type { schema } from '../livestore/index.ts'
import { AppsAdminApiLive } from './index.ts'

type AppsStoreService = Store<typeof schema, object>

// The server handlers don't read from the store, but `AppsAdminApiLive`
// merges in the `apps-admin` group whose handlers do — so we still need
// to satisfy the `AppsStore` requirement.
const makeStubStore = (): AppsStoreService => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query: vi.fn(),
    commit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as AppsStoreService
}

const createHandler = (
  tunnel: TunnelControlService
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AppsAdminApiLive.pipe(
    Layer.provide(makeAppsStoreLayer(makeStubStore())),
    Layer.provide(Layer.succeed(TunnelControl, tunnel))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

describe('GetServer handler', () => {
  it('returns the static ServerState from the TunnelControl', async () => {
    const state: ServerState = {
      origin: 'https://tunnel.example.com',
      localOrigin: 'http://localhost:8787',
      port: 8787,
      tunnelActive: false,
    }
    const tunnel: TunnelControlService = {
      getState: Effect.succeed(state),
      setTunnelActive: () => Effect.succeed(state),
    }
    const { handler, dispose } = createHandler(tunnel)
    try {
      const response = await handler(new Request('http://localhost/server'))
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ServerState
      expect(body).toEqual(state)
    } finally {
      await dispose()
    }
  })
})

describe('PatchServer handler', () => {
  it('returns the updated server state on success', async () => {
    const baseState: ServerState = {
      origin: 'https://tunnel.example.com',
      localOrigin: 'http://localhost:8787',
      port: 8787,
      tunnelActive: false,
    }
    const setTunnelActive = vi.fn(
      (active: boolean): Effect.Effect<ServerState, TunnelUnavailable> =>
        Effect.succeed({ ...baseState, tunnelActive: active })
    )
    const { handler, dispose } = createHandler({
      getState: Effect.succeed(baseState),
      setTunnelActive,
    })
    try {
      const response = await handler(
        new Request('http://localhost/server', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tunnelActive: true }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ServerState
      expect(body.tunnelActive).toBe(true)
      expect(setTunnelActive).toHaveBeenCalledWith(true)
    } finally {
      await dispose()
    }
  })

  it('returns TunnelUnavailable (409) when the TunnelControl service fails', async () => {
    const baseState: ServerState = {
      origin: 'https://tunnel.example.com',
      localOrigin: 'http://localhost:8787',
      port: 8787,
      tunnelActive: false,
    }
    const { handler, dispose } = createHandler({
      getState: Effect.succeed(baseState),
      setTunnelActive: () => Effect.fail(new TunnelUnavailable({ reason: 'quota-exceeded' })),
    })
    try {
      const response = await handler(
        new Request('http://localhost/server', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tunnelActive: true }),
        })
      )
      expect(response.status).toBe(409)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; reason: string }
      expect(body.error).toBe('TunnelUnavailable')
      expect(body.reason).toBe('quota-exceeded')
    } finally {
      await dispose()
    }
  })
})

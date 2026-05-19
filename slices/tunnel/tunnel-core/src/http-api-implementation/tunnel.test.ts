import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, type Store } from '@livestore/livestore'
import { Layer, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { TunnelStateSchema } from '../http-api-definition/tunnel.ts'
import { schema, TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'
import { TunnelAdminApiLive } from './index.ts'

const decodeBody = Schema.decodeUnknownSync(TunnelStateSchema)

let store: Store<typeof schema, object>

beforeEach(async () => {
  store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `tunnel-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
})

afterEach(async () => {
  await store.shutdownPromise().catch(() => undefined)
})

const buildHandler = (): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = TunnelAdminApiLive.pipe(Layer.provide(TunnelStore.layerFrom(store)))
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

describe('GetTunnel handler', () => {
  it('returns the merged config + state snapshot', async () => {
    store.commit(
      TunnelConfig.events.tunnelConfigSet({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
      })
    )
    store.commit(
      TunnelState.events.tunnelStateSet({
        currentEnabled: true,
        currentSubdomain: 'wildflower-expo-dev',
        currentRootDomain: 'loca.lt',
        currentLocalPort: 8080,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/tunnel'))
      expect(response.status).toBe(200)
      const body = decodeBody(await response.json())
      expect(body).toEqual({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
        currentEnabled: true,
        currentSubdomain: 'wildflower-expo-dev',
        currentRootDomain: 'loca.lt',
        currentLocalPort: 8080,
        error: null,
      })
    } finally {
      await dispose()
    }
  })

  it('returns the defaults when nothing has been committed (fresh install)', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/tunnel'))
      expect(response.status).toBe(200)
      const body = decodeBody(await response.json())
      expect(body).toEqual({
        subdomain: null,
        rootDomain: null,
        localPort: null,
        requestedEnabled: false,
        currentEnabled: false,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
        error: null,
      })
    } finally {
      await dispose()
    }
  })
})

describe('PatchTunnel handler', () => {
  it('seeds the TunnelConfig row on first patch', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/tunnel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subdomain: 'wildflower-expo-dev',
            rootDomain: 'loca.lt',
            localPort: 8080,
            requestedEnabled: true,
          }),
        })
      )
      expect(response.status).toBe(200)
      const stored = store.query(TunnelConfig.queries.current$)
      expect(stored).toMatchObject({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
      })
    } finally {
      await dispose()
    }
  })

  it('preserves omitted fields when patching just requestedEnabled', async () => {
    store.commit(
      TunnelConfig.events.tunnelConfigSet({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/tunnel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestedEnabled: true }),
        })
      )
      expect(response.status).toBe(200)
      const stored = store.query(TunnelConfig.queries.current$)
      expect(stored).toMatchObject({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
      })
    } finally {
      await dispose()
    }
  })

  it('explicitly clears a field when sent null', async () => {
    store.commit(
      TunnelConfig.events.tunnelConfigSet({
        subdomain: 'wildflower-expo-dev',
        rootDomain: 'loca.lt',
        localPort: 8080,
        requestedEnabled: true,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/tunnel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subdomain: null }),
        })
      )
      expect(response.status).toBe(200)
      const stored = store.query(TunnelConfig.queries.current$)
      expect(stored?.subdomain).toBeNull()
      // Other fields preserved.
      expect(stored?.rootDomain).toBe('loca.lt')
      expect(stored?.requestedEnabled).toBe(true)
    } finally {
      await dispose()
    }
  })
})

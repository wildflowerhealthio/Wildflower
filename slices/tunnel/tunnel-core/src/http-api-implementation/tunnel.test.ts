import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, type Store, State } from '@livestore/livestore'
import { Layer } from 'effect'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import * as TunnelLivestore from '../livestore/index.ts'
import { TunnelAdminApiLive } from './index.ts'

// Combined test schema — both slices' tables/events/materializers live
// in the same in-memory store so the handlers can read/write either.
const tables = {
  ...TunnelLivestore.tables,
  ...LocalHttpServerLivestore.tables,
} as const
const events = {
  ...TunnelLivestore.events,
  ...LocalHttpServerLivestore.events,
} as const
const materializers = State.SQLite.materializers(events, {
  ...TunnelLivestore.materializers,
  ...LocalHttpServerLivestore.materializers,
})
const testState = State.SQLite.makeState({ tables, materializers })
const testSchema = makeSchema({ events, state: testState })

let store: Store<typeof testSchema, object>

beforeEach(async () => {
  store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema: testSchema,
    storeId: `tunnel-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
})

afterEach(async () => {
  await store.shutdownPromise().catch(() => undefined)
})

const buildHandler = (): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = TunnelAdminApiLive.pipe(
    Layer.provide(TunnelLivestore.TunnelStore.layerFrom(store)),
    Layer.provide(LocalHttpServerLivestore.LocalHttpServerStore.layerFrom(store))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

describe('GetTunnel handler', () => {
  it('returns the merged store snapshot', async () => {
    store.commit(
      LocalHttpServerLivestore.events.localHttpServerStateSet({
        running: true,
        port: 8787,
        localOrigin: 'http://127.0.0.1:8787',
      })
    )
    store.commit(
      TunnelLivestore.events.tunnelStateSet({
        requestedPublicOrigin: 'https://wildflower-expo-dev.loca.lt',
        currentPublicOrigin: 'https://wildflower-expo-dev.loca.lt',
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/tunnel'))
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as {
        requestedPublicOrigin: string | undefined
        currentPublicOrigin: string | undefined
        localOrigin: string | undefined
        port: number | undefined
        running: boolean
      }
      expect(body).toEqual({
        requestedPublicOrigin: 'https://wildflower-expo-dev.loca.lt',
        currentPublicOrigin: 'https://wildflower-expo-dev.loca.lt',
        localOrigin: 'http://127.0.0.1:8787',
        port: 8787,
        running: true,
      })
    } finally {
      await dispose()
    }
  })

  it('returns the empty default when nothing has been committed', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/tunnel'))
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { running: boolean }
      expect(body.running).toBe(false)
    } finally {
      await dispose()
    }
  })
})

describe('PatchTunnel handler', () => {
  it('commits a new requestedPublicOrigin and returns the post-commit snapshot', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/tunnel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestedPublicOrigin: 'https://wildflower-expo-dev.loca.lt' }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { requestedPublicOrigin: string }
      expect(body.requestedPublicOrigin).toBe('https://wildflower-expo-dev.loca.lt')
      const stored = store.query(TunnelLivestore.queries.current$)
      expect(stored.requestedPublicOrigin).toBe('https://wildflower-expo-dev.loca.lt')
    } finally {
      await dispose()
    }
  })

  it('clears requestedPublicOrigin when sent null', async () => {
    store.commit(
      TunnelLivestore.events.tunnelStateSet({
        requestedPublicOrigin: 'https://wildflower-expo-dev.loca.lt',
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/tunnel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestedPublicOrigin: null }),
        })
      )
      expect(response.status).toBe(200)
      const stored = store.query(TunnelLivestore.queries.current$)
      expect(stored.requestedPublicOrigin).toBeNull()
    } finally {
      await dispose()
    }
  })
})

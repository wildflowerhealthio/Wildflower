import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, State, type Store } from '@livestore/livestore'
import { Layer } from 'effect'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import {
  TunnelConfig,
  TunnelState,
  TunnelStore,
  events as tunnelEvents,
  materializers as tunnelMaterializers,
  tables as tunnelTables,
} from 'tunnel-core/livestore'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  type AppSelectionRow,
  AppSelection,
  AppsStore,
  events as appsEvents,
  materializers as appsMaterializers,
} from '../livestore/index.ts'
import { AppsApiLive } from './index.ts'

// Combined test schema — all three slices' tables/events/materializers
// live in the same in-memory store so the handlers can read/write any.
const tables = {
  appSelection: AppSelection.table,
  ...LocalHttpServerLivestore.tables,
  ...tunnelTables,
} as const

const events = {
  ...appsEvents,
  ...LocalHttpServerLivestore.events,
  ...tunnelEvents,
} as const

const materializers = State.SQLite.materializers(events, {
  ...appsMaterializers,
  ...tunnelMaterializers,
})
const testState = State.SQLite.makeState({ tables, materializers })
const testSchema = makeSchema({ events, state: testState })

let store: Store<typeof testSchema, object>

beforeEach(async () => {
  store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema: testSchema,
    storeId: `apps-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
})

afterEach(async () => {
  await store.shutdownPromise().catch(() => undefined)
})

const seedRows = (rows: ReadonlyArray<AppSelectionRow>): void => {
  for (const row of rows) {
    if (row.kind === 'custom') {
      store.commit(
        appsEvents.customAppAdded({
          id: row.id,
          name: row.customName ?? 'Unnamed',
          url: row.customUrl ?? '',
          requiresTunnel: row.customRequiresTunnel ?? false,
        })
      )
      if (!row.enabled) {
        store.commit(appsEvents.appEnabledChanged({ id: row.id, kind: 'custom', enabled: false }))
      }
    } else {
      // Test fixtures only construct `'bundled'` and `'action'` non-custom
      // kinds; the row schema widens to `string`, so narrow at the boundary.
      if (row.kind !== 'bundled' && row.kind !== 'action') continue
      store.commit(
        appsEvents.appEnabledChanged({
          id: row.id,
          kind: row.kind,
          enabled: row.enabled,
        })
      )
    }
  }
}

const seedTunnelUp = (subdomain = 'tunnel', rootDomain = 'example.com'): void => {
  store.commit(
    TunnelState.events.tunnelStateSet({
      currentEnabled: true,
      currentSubdomain: subdomain,
      currentRootDomain: rootDomain,
      currentLocalPort: 8080,
    })
  )
}

const seedTunnelConfig = (
  patch: Parameters<typeof TunnelConfig.events.tunnelConfigSet>[0]
): void => {
  store.commit(TunnelConfig.events.tunnelConfigSet(patch))
}

const seedLocalServer = (localOrigin = 'http://127.0.0.1:8080'): void => {
  store.commit(
    LocalHttpServerLivestore.events.localHttpServerStateSet({
      running: true,
      port: 8080,
      localOrigin,
    })
  )
}

const buildHandler = (): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AppsApiLive.pipe(
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(TunnelStore.layerFrom(store)),
    Layer.provide(LocalHttpServerLivestore.LocalHttpServerStore.layerFrom(store))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

// --- ListApps tests ---------------------------------------------------

describe('ListApps handler', () => {
  it('returns every bundled app even when the selection table is empty', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ReadonlyArray<{
        id: string
        kind: string
        enabled: boolean
      }>
      const fhirSharing = body.find((a) => a.id === 'fhir-sharing')
      expect(fhirSharing).toBeDefined()
      expect(fhirSharing?.kind).toBe('action')
      expect(fhirSharing?.enabled).toBe(true)
      expect(body.every((a) => a.kind !== 'custom')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('merges enabled flag overrides from selection rows', async () => {
    seedRows([
      {
        id: 'patient-browser',
        kind: 'bundled',
        enabled: false,
        customName: null,
        customUrl: null,
        customRequiresTunnel: null,
      },
    ])
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ReadonlyArray<{ id: string; enabled: boolean }>
      const patientBrowser = body.find((a) => a.id === 'patient-browser')
      expect(patientBrowser?.enabled).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('appends custom rows after bundled entries', async () => {
    seedRows([
      {
        id: 'custom-abc',
        kind: 'custom',
        enabled: true,
        customName: 'My App',
        customUrl: 'https://example.com/launch',
        customRequiresTunnel: true,
      },
    ])
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ReadonlyArray<{
        id: string
        kind: string
        name: string
        subtitle?: string
        requiresTunnel: boolean
      }>
      const custom = body.find((a) => a.id === 'custom-abc')
      expect(custom).toBeDefined()
      expect(custom?.kind).toBe('custom')
      expect(custom?.name).toBe('My App')
      expect(custom?.subtitle).toBe('https://example.com/launch')
      expect(custom?.requiresTunnel).toBe(true)
    } finally {
      await dispose()
    }
  })
})

// --- LaunchApp tests --------------------------------------------------

describe('LaunchApp handler', () => {
  it('redirects to the bundled url for a non-action app that does not require a tunnel', async () => {
    seedLocalServer('http://127.0.0.1:8080')
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/patient-browser'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        'http://127.0.0.1:8080/installed-apps/patient-browser/index.html'
      )
    } finally {
      await dispose()
    }
  })

  it('redirects an action app (fhir-sharing) to the tunnel origin when tunnel is already up', async () => {
    seedLocalServer()
    seedTunnelUp('tunnel', 'example.com')
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/fhir-sharing'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://tunnel.example.com')
    } finally {
      await dispose()
    }
  })

  it('commits requestedEnabled and waits for currentEnabled before redirecting', async () => {
    seedLocalServer()
    seedTunnelConfig({ subdomain: 'tunnel', rootDomain: 'example.com', localPort: 8080 })

    // After the handler commits requestedEnabled: true, simulate the
    // daemon flipping currentEnabled. Subscribe-once helper races with
    // the handler.
    const settle = store.subscribe(TunnelConfig.queries.current$, (config) => {
      if (config?.requestedEnabled === true) {
        seedTunnelUp('tunnel', 'example.com')
        settle()
      }
    })

    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/growth-chart'))
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('https://examples.smarthealthit.org/growth-chart-app/launch.html')
      expect(location).toContain('iss=https://tunnel.example.com/fhir-r4')
    } finally {
      settle()
      await dispose()
    }
  })

  it('falls back to localOrigin when the tunnel await times out', async () => {
    // No daemon, no tunnel-up commit — the handler's
    // awaitCurrentEnabled hits its 15s timeout and falls back.
    seedLocalServer('http://127.0.0.1:9090')
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/medication-viewer'))
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('iss=http://127.0.0.1:9090/fhir-r4')
    } finally {
      await dispose()
    }
  }, 20_000)

  it('redirects a custom app whose template resolves to a same-origin path', async () => {
    seedLocalServer('http://127.0.0.1:8080')
    seedRows([
      {
        id: 'custom-1',
        kind: 'custom',
        enabled: true,
        customName: 'My App',
        customUrl: '{origin}/some/path',
        customRequiresTunnel: false,
      },
    ])
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('http://127.0.0.1:8080/some/path')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is neither same-origin nor https://', async () => {
    seedLocalServer()
    seedRows([
      {
        id: 'custom-1',
        kind: 'custom',
        enabled: true,
        customName: 'My App',
        customUrl: 'http://insecure.example.com/x',
        customRequiresTunnel: false,
      },
    ])
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(404)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('AppNotFound')
      expect(body.id).toBe('custom-1')
    } finally {
      await dispose()
    }
  })

  it('returns 404 for an unknown id', async () => {
    seedLocalServer()
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/no-such-app'))
      expect(response.status).toBe(404)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('AppNotFound')
      expect(body.id).toBe('no-such-app')
    } finally {
      await dispose()
    }
  })
})

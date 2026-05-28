/**
 * Integration tests for `LaunchApp` + `ListApps`. Backs `AppsStore` +
 * `TunnelStore` + `LocalHttpServerStore` with a single in-memory
 * `@livestore/adapter-node` store whose schema spreads each slice's
 * `tables` / `events` / `materializers` records. Tunnel "daemon" events
 * are committed by hand to simulate the relay bind.
 */
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, type Store, State } from '@livestore/livestore'
import { Layer, Schema } from 'effect'
import fc from 'fast-check'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import * as TunnelLivestore from 'tunnel-core/livestore'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { AppListSchema, AppNotFoundSchema } from '../http-api-definition/schemas.ts'
import * as AppsLivestore from '../livestore/index.ts'
import { AppSelection, AppsStore } from '../livestore/index.ts'
import { AppsApiLive } from './index.ts'

const tables = {
  ...AppsLivestore.tables,
  ...TunnelLivestore.tables,
  ...LocalHttpServerLivestore.tables,
} as const

const events = {
  ...AppsLivestore.events,
  ...TunnelLivestore.events,
  ...LocalHttpServerLivestore.events,
}

const materializers = State.SQLite.materializers(events, {
  ...AppsLivestore.materializers,
  ...TunnelLivestore.materializers,
  ...LocalHttpServerLivestore.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })
const schema = makeSchema({ events, state })

let store: Store<typeof schema, object>

beforeEach(async () => {
  store = await createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `apps-launch-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
})

afterEach(async () => {
  await store.shutdownPromise().catch(() => undefined)
})

const LOCAL_HOSTNAME = '127.0.0.1'
const LOCAL_ORIGIN = 'http://127.0.0.1:8787'
const TUNNEL_SUBDOMAIN = 'wildflower-test'
const TUNNEL_ROOT_DOMAIN = 'loca.lt'
const TUNNEL_ORIGIN = `https://${TUNNEL_SUBDOMAIN}.${TUNNEL_ROOT_DOMAIN}`

const seedLocalHostname = (hostname: string = LOCAL_HOSTNAME): void => {
  store.commit(
    LocalHttpServerLivestore.ServerState.events.localHttpServerStateSet({
      localHostname: hostname,
      running: true,
      port: 8787,
    })
  )
}

const seedTunnelRunning = (): void => {
  store.commit(
    TunnelLivestore.TunnelState.events.tunnelStateSet({
      running: true,
      currentSubdomain: TUNNEL_SUBDOMAIN,
      currentRootDomain: TUNNEL_ROOT_DOMAIN,
      currentLocalPort: 8787,
    })
  )
}

/**
 * Resolve when the handler's `tunnelConfigSet({ requestedRunning: true })`
 * commit is observable in the store. The launch handler commits this
 * just before subscribing to `TunnelState`, so waiting on it is a
 * deterministic synchronisation point.
 */
const waitForRequestedRunning = async (): Promise<void> => {
  const deadlineMs = Date.now() + 5_000
  while (Date.now() < deadlineMs) {
    const config = store.query(TunnelLivestore.TunnelConfig.queries.current$)
    if (config?.requestedRunning === true) return
    // oxlint-disable-next-line no-await-in-loop -- poll must observe each tick sequentially
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('handler did not commit requestedRunning=true within 5s')
}

const buildHandler = (): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AppsApiLive.pipe(
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(TunnelLivestore.TunnelStore.layerFrom(store)),
    Layer.provide(LocalHttpServerLivestore.LocalHttpServerStore.layerFrom(store))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

describe('ListApps handler', () => {
  it('returns every bundled app even when the selection table is empty', async () => {
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      expect(response.status).toBe(200)
      const body = Schema.decodeUnknownSync(AppListSchema)(await response.json())
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
    store.commit(
      AppSelection.events.appEnabledChanged({
        id: 'patient-browser',
        kind: 'bundled',
        enabled: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      const body = Schema.decodeUnknownSync(AppListSchema)(await response.json())
      const patientBrowser = body.find((a) => a.id === 'patient-browser')
      expect(patientBrowser?.enabled).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('appends custom rows after bundled entries', async () => {
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-abc',
        name: 'My App',
        url: 'https://example.com/launch',
        requiresTunnel: true,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps'))
      const body = Schema.decodeUnknownSync(AppListSchema)(await response.json())
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

describe('LaunchApp handler', () => {
  it('redirects to the local origin for a non-action app that does not require a tunnel', async () => {
    seedLocalHostname()
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/patient-browser'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        `${LOCAL_ORIGIN}/installed-apps/patient-browser/index.html`
      )
    } finally {
      await dispose()
    }
  })

  it('redirects an action app (fhir-sharing) to the tunnel origin when the tunnel is already running', async () => {
    seedLocalHostname()
    seedTunnelRunning()
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/fhir-sharing'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(TUNNEL_ORIGIN)
    } finally {
      await dispose()
    }
  })

  it('commits requestedRunning=true and awaits the daemon flipping running=true', async () => {
    seedLocalHostname()
    const { handler, dispose } = buildHandler()
    try {
      const responsePromise = handler(new Request('http://localhost/apps/growth-chart'))
      await waitForRequestedRunning()
      seedTunnelRunning()

      const response = await responsePromise
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('https://examples.smarthealthit.org/growth-chart-app/launch.html')
      expect(location).toContain(`iss=${TUNNEL_ORIGIN}/fhir-r4`)

      const config = store.query(TunnelLivestore.TunnelConfig.queries.current$)
      expect(config?.requestedRunning).toBe(true)
    } finally {
      await dispose()
    }
  }, 20_000)

  it('falls back to the local origin and signals tunnel=unavailable when running=true but subdomain/rootDomain are unbound', async () => {
    seedLocalHostname()
    store.commit(
      TunnelLivestore.TunnelState.events.tunnelStateSet({
        running: true,
        currentSubdomain: null,
        currentRootDomain: null,
        currentLocalPort: null,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/medication-viewer'))
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('https://mitre.github.io/smart-on-fhir-demo/launch.html')
      expect(location).toContain(`iss=${LOCAL_ORIGIN}/fhir-r4`)
      expect(new URL(location).searchParams.get('tunnel')).toBe('unavailable')
    } finally {
      await dispose()
    }
  })

  it('redirects a custom app whose template resolves to a same-origin path', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-1',
        name: 'My App',
        url: '{origin}/some/path',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${LOCAL_ORIGIN}/some/path`)
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is neither same-origin nor https://', async () => {
    seedLocalHostname()
    // CustomAppUrlSchema would reject `http://` on write; commit
    // directly to exercise the launch-time defense-in-depth check.
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-1',
        name: 'My App',
        url: 'http://insecure.example.com/x',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
      expect(body.id).toBe('custom-1')
    } finally {
      await dispose()
    }
  })

  // Regression guards for the launch-time URL allowlist. `isLaunchableUrl`
  // is module-local, so we exercise it through `LaunchApp`'s 302-vs-404
  // surface. Custom-URL events go through `AppSelection.events.customAppAdded`
  // directly to bypass `CustomAppUrlSchema` and reach the launch-time check.
  it('launches a custom app whose resolved url is an absolute https:// URL', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-https',
        name: 'My App',
        url: 'https://example.com/foo',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-https'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://example.com/foo')
    } finally {
      await dispose()
    }
  })

  it('launches a custom app whose resolved url shares the live loopback origin (origin-prefix branch)', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-origin',
        name: 'My App',
        url: '{origin}/foo',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-origin'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${LOCAL_ORIGIN}/foo`)
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is a non-loopback http:// URL', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-http',
        name: 'My App',
        url: 'http://example.com/foo',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-http'))
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is loopback on a non-origin port', async () => {
    // Regression guard: a prior implementation accepted any URL whose
    // hostname was `127.0.0.1` regardless of port/scheme. After the
    // tightening, only URLs starting with the live `originPrefix`
    // (loopback host + port) are accepted on the loopback branch.
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-loopback-other-port',
        name: 'My App',
        url: 'http://127.0.0.1:19000/foo',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(
        new Request('http://localhost/apps/custom-loopback-other-port')
      )
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url has a non-http(s) scheme on the loopback host', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-ftp',
        name: 'My App',
        url: 'ftp://127.0.0.1/foo',
        requiresTunnel: false,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/custom-ftp'))
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  })

  it('returns 404 for an unknown id', async () => {
    seedLocalHostname()
    const { handler, dispose } = buildHandler()
    try {
      const response = await handler(new Request('http://localhost/apps/no-such-app'))
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
      expect(body.id).toBe('no-such-app')
    } finally {
      await dispose()
    }
  })

  it('returns 404 when a custom row exists before tunnel activation but disappears mid-flight', async () => {
    seedLocalHostname()
    store.commit(
      AppSelection.events.customAppAdded({
        id: 'custom-1',
        name: 'My App',
        url: '{origin}/path',
        requiresTunnel: true,
      })
    )
    const { handler, dispose } = buildHandler()
    try {
      const responsePromise = handler(new Request('http://localhost/apps/custom-1'))
      await waitForRequestedRunning()
      store.commit(AppSelection.events.customAppRemoved({ id: 'custom-1' }))
      seedTunnelRunning()
      const response = await responsePromise
      expect(response.status).toBe(404)
      const body = Schema.decodeUnknownSync(AppNotFoundSchema)(await response.json())
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  }, 20_000)
})

describe('LaunchApp property tests', () => {
  // Path segments use the RFC 3986 path-segment alphabet (unreserved +
  // sub-delims + `:` and `@`, minus `&` which collides with query
  // parsing). Excluding the single-dot and double-dot segments since
  // the URL parser removes those during `remove_dot_segments` —
  // `pathname` of `/a/.` is `/a/`. Multi-segment paths exercise `/`.
  const segmentArb = fc
    .stringMatching(/^[a-zA-Z0-9\-_.~!$'()*+,;:@=]{1,8}$/)
    .filter((s) => s !== '.' && s !== '..')
  const pathArb = fc
    .array(segmentArb, { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
  const idArb = fc.stringMatching(/^[a-zA-Z0-9-]{1,16}$/)

  it('non-tunnel custom app launches resolve to a redirect whose origin is the local origin, whose pathname mirrors the template path, and which carries no `tunnel=unavailable` signal', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, pathArb, async (idSuffix, path) => {
        const localStore = await createStorePromise({
          adapter: makeAdapter({ storage: { type: 'in-memory' } }),
          schema,
          storeId: `prop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        })
        try {
          localStore.commit(
            LocalHttpServerLivestore.ServerState.events.localHttpServerStateSet({
              localHostname: LOCAL_HOSTNAME,
              running: true,
              port: 8787,
            })
          )
          const id = `custom-${idSuffix}`
          localStore.commit(
            AppSelection.events.customAppAdded({
              id,
              name: 'My App',
              url: `{origin}/${path}`,
              requiresTunnel: false,
            })
          )
          const apiLive = AppsApiLive.pipe(
            Layer.provide(AppsStore.layerFrom(localStore)),
            Layer.provide(TunnelLivestore.TunnelStore.layerFrom(localStore)),
            Layer.provide(LocalHttpServerLivestore.LocalHttpServerStore.layerFrom(localStore))
          )
          const { handler, dispose } = HttpApiBuilder.toWebHandler(
            Layer.merge(apiLive, HttpServer.layerContext)
          )
          try {
            const response = await handler(
              new Request(`http://localhost/apps/${encodeURIComponent(id)}`)
            )
            expect(response.status).toBe(302)
            const location = response.headers.get('location') ?? ''
            const url = new URL(location)
            expect(url.origin).toBe(LOCAL_ORIGIN)
            expect(url.pathname).toBe(`/${path}`)
            expect(url.search).toBe('')
            expect(url.hash).toBe('')
          } finally {
            await dispose()
          }
        } finally {
          await localStore.shutdownPromise().catch(() => undefined)
        }
      }),
      { numRuns: 25 }
    )
  }, 60_000)
})

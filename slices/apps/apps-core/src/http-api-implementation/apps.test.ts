import { HttpApiBuilder, HttpServer } from '@effect/platform'
import type { Store } from '@livestore/livestore'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  type ServerState,
  TunnelControl,
  TunnelUnavailable,
  type TunnelControlService,
} from '../contexts/tunnel-control.ts'
import {
  type AppSelectionRow,
  AppsStore,
  queries as livestoreQueries,
  type schema,
} from '../livestore/index.ts'
import { AppsApiLive } from './index.ts'

// `AppsStore.Service` is just a `Store<schema, object>`. The test only
// hits `query`, so we type the helper through that surface.
type AppsStoreService = Store<typeof schema, object>

// --- Test fixtures ----------------------------------------------------

const baseServerState = (overrides: Partial<ServerState> = {}): ServerState => ({
  origin: 'https://tunnel.example.com',
  localOrigin: 'http://localhost:8787',
  port: 8787,
  tunnelActive: false,
  ...overrides,
})

interface MockTunnelOptions {
  state?: ServerState
  // Pre-canned sequence of states `setTunnelActive` should resolve to.
  // Defaults to flipping `tunnelActive` to the requested value.
  setTunnelActiveResult?: (active: boolean) => Effect.Effect<ServerState, TunnelUnavailable>
}

const makeMockTunnel = (options: MockTunnelOptions = {}): TunnelControlService => {
  let currentState = options.state ?? baseServerState()
  return {
    getState: Effect.sync(() => currentState),
    setTunnelActive:
      options.setTunnelActiveResult ??
      ((active: boolean): Effect.Effect<ServerState, TunnelUnavailable> => {
        currentState = { ...currentState, tunnelActive: active }
        return Effect.succeed(currentState)
      }),
  }
}

// Identify a LiveQueryDef by its stable `hash` — same approach as
// gatekeeper-core's oauth-endpoints.test.ts.
const queryHash = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

interface MockStoreOptions {
  rows?: ReadonlyArray<AppSelectionRow>
  // Override `byId$` lookup on a per-call basis (useful for the
  // row-disappears-mid-flight test).
  byIdImpl?: (id: string) => AppSelectionRow | undefined
}

const makeMockStore = (options: MockStoreOptions = {}): AppsStoreService => {
  const rowsArr: AppSelectionRow[] = [...(options.rows ?? [])]
  const byIdImpl = options.byIdImpl ?? ((id: string) => rowsArr.find((r) => r.id === id))

  const query = vi.fn((q: unknown): unknown => {
    if (q === livestoreQueries.appSelection$) {
      return rowsArr
    }
    const hash = queryHash(q)
    if (hash !== undefined) {
      // Cheap reverse lookup: try every known id against `byId$.hash`.
      for (const row of rowsArr) {
        if (livestoreQueries.appSelectionById$(row.id).hash === hash) {
          return byIdImpl(row.id)
        }
      }
      // The row may not be in `rowsArr` (e.g. unknown id) — fall back to
      // a fresh probe so `byIdImpl` can return something useful too.
      // We don't know the id without the hash → call byIdImpl with each
      // candidate from `rowsArr` already; the only remaining case is a
      // miss, so return undefined.
      return undefined
    }
    return undefined
  })

  // The handler only needs `query`. Keep the mock minimal.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query,
    commit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as AppsStoreService
}

// Drop in a stub that lets us probe `byId$` lookups by id regardless of
// the underlying `rows` array — used by the race-condition test where
// the first call returns a row and the second returns undefined.
const makeMockStoreWithDynamicById = (
  byIdImpl: (id: string) => AppSelectionRow | undefined
): AppsStoreService => {
  // The handler asks for byId twice in the same request when the entry
  // is custom + tunnel work happened. We pre-register every id we'll
  // probe so the hash lookup can find them.
  const knownIds = ['custom-1', 'custom-mystery']
  const query = vi.fn((q: unknown): unknown => {
    if (q === livestoreQueries.appSelection$) {
      // Test only reaches this branch from LaunchApp; return empty.
      return []
    }
    const hash = queryHash(q)
    if (hash !== undefined) {
      for (const id of knownIds) {
        if (livestoreQueries.appSelectionById$(id).hash === hash) {
          return byIdImpl(id)
        }
      }
    }
    return undefined
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query,
    commit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as AppsStoreService
}

// --- Wire up the handler via toWebHandler ----------------------------

const createHandler = (
  store: AppsStoreService,
  tunnel: TunnelControlService
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AppsApiLive.pipe(
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(Layer.succeed(TunnelControl, tunnel))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

// --- ListApps tests ---------------------------------------------------

describe('ListApps handler', () => {
  it('returns every bundled app even when the selection table is empty', async () => {
    const { handler, dispose } = createHandler(makeMockStore(), makeMockTunnel())
    try {
      const response = await handler(new Request('http://localhost/apps'))
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as ReadonlyArray<{
        id: string
        kind: string
        enabled: boolean
      }>
      // Bundled apps default to enabled.
      const fhirSharing = body.find((a) => a.id === 'fhir-sharing')
      expect(fhirSharing).toBeDefined()
      expect(fhirSharing?.kind).toBe('action')
      expect(fhirSharing?.enabled).toBe(true)
      // No custom apps in the selection → none in the response.
      expect(body.every((a) => a.kind !== 'custom')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('merges enabled flag overrides from selection rows', async () => {
    const store = makeMockStore({
      rows: [
        {
          id: 'patient-browser',
          kind: 'bundled',
          enabled: false,
          customName: null,
          customUrl: null,
          customRequiresTunnel: null,
        },
      ],
    })
    const { handler, dispose } = createHandler(store, makeMockTunnel())
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
    const store = makeMockStore({
      rows: [
        {
          id: 'custom-abc',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: 'https://example.com/launch',
          customRequiresTunnel: true,
        },
      ],
    })
    const { handler, dispose } = createHandler(store, makeMockTunnel())
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
    const { handler, dispose } = createHandler(
      makeMockStore(),
      makeMockTunnel({ state: baseServerState({ tunnelActive: false }) })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/patient-browser'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        'https://tunnel.example.com/installed-apps/patient-browser/index.html'
      )
    } finally {
      await dispose()
    }
  })

  it('redirects an action app (fhir-sharing) to the origin', async () => {
    // fhir-sharing requires the tunnel; start with it active so the
    // handler doesn't try to flip it on.
    const { handler, dispose } = createHandler(
      makeMockStore(),
      makeMockTunnel({ state: baseServerState({ tunnelActive: true }) })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/fhir-sharing'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://tunnel.example.com')
    } finally {
      await dispose()
    }
  })

  it('activates the tunnel before redirect when a bundled app requires one', async () => {
    const setTunnelActive = vi.fn(
      (active: boolean): Effect.Effect<ServerState, TunnelUnavailable> =>
        Effect.succeed(baseServerState({ tunnelActive: active }))
    )
    const { handler, dispose } = createHandler(
      makeMockStore(),
      makeMockTunnel({
        state: baseServerState({ tunnelActive: false }),
        setTunnelActiveResult: setTunnelActive,
      })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/growth-chart'))
      expect(setTunnelActive).toHaveBeenCalledWith(true)
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      // Growth-chart's URL pattern is an external host with the live
      // origin as the `iss` query param. We only verify the host + iss.
      expect(location).toContain('https://examples.smarthealthit.org/growth-chart-app/launch.html')
      expect(location).toContain('iss=https://tunnel.example.com/fhir-r4')
    } finally {
      await dispose()
    }
  })

  it('logs a warning and falls back to the bundled url when tunnel activation fails', async () => {
    const failedActivate = vi.fn(
      (_active: boolean): Effect.Effect<ServerState, TunnelUnavailable> =>
        Effect.fail(new TunnelUnavailable({ reason: 'no-credentials' }))
    )
    const { handler, dispose } = createHandler(
      makeMockStore(),
      makeMockTunnel({
        state: baseServerState({ tunnelActive: false }),
        setTunnelActiveResult: failedActivate,
      })
    )
    try {
      // patient-browser is non-action and doesn't itself require a
      // tunnel, but the *logging-warning* path can fire on any app that
      // does require one. Use `medication-viewer` (requires tunnel,
      // non-action) so we get the warning + still 302 to the bundled
      // URL with `iss=` pointing at the *original* (non-tunneled)
      // origin.
      const response = await handler(new Request('http://localhost/apps/medication-viewer'))
      expect(failedActivate).toHaveBeenCalled()
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('https://mitre.github.io/smart-on-fhir-demo/launch.html')
      // Origin still the un-activated origin (handler falls back to
      // `beforeState`).
      expect(location).toContain('iss=https://tunnel.example.com/fhir-r4')
    } finally {
      await dispose()
    }
  })

  it('redirects a custom app whose template resolves to a same-origin path', async () => {
    const store = makeMockStore({
      rows: [
        {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: '{origin}/some/path',
          customRequiresTunnel: false,
        },
      ],
    })
    const { handler, dispose } = createHandler(
      store,
      makeMockTunnel({ state: baseServerState({ tunnelActive: false }) })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://tunnel.example.com/some/path')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is neither same-origin nor https://', async () => {
    // Set a customUrl that bypasses the schema (e.g. an absolute
    // http:// URL — schema would reject, but we're testing the launch-
    // time defense-in-depth check directly via a mocked row).
    const store = makeMockStore({
      rows: [
        {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: 'http://insecure.example.com/x',
          customRequiresTunnel: false,
        },
      ],
    })
    const { handler, dispose } = createHandler(store, makeMockTunnel())
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
    const { handler, dispose } = createHandler(makeMockStore(), makeMockTunnel())
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

  it('returns 404 when a custom row exists before tunnel activation but disappears mid-flight', async () => {
    let calls = 0
    const byIdImpl = (id: string): AppSelectionRow | undefined => {
      calls += 1
      if (id !== 'custom-1') return undefined
      if (calls === 1) {
        return {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: '{origin}/path',
          customRequiresTunnel: true,
        }
      }
      // Second call (after tunnel state settles) — row gone.
      return undefined
    }
    const store = makeMockStoreWithDynamicById(byIdImpl)
    const { handler, dispose } = createHandler(
      store,
      makeMockTunnel({ state: baseServerState({ tunnelActive: false }) })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(404)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  })
})

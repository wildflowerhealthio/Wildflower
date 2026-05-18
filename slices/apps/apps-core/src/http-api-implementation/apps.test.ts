import { HttpApiBuilder, HttpServer } from '@effect/platform'
import type { Store } from '@livestore/livestore'
import { Effect, Layer } from 'effect'
import { PublicOrigin } from 'tunnel-core/contexts'
import {
  queries as tunnelQueries,
  type schema as tunnelSchema,
  TunnelStore,
} from 'tunnel-core/livestore'
import { describe, expect, it, vi } from 'vite-plus/test'

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
type TunnelStoreService = Store<typeof tunnelSchema, object>

interface TunnelStateView {
  requestedPublicOrigin: string | null
  currentPublicOrigin: string | null
}

interface MockTunnelOptions {
  initial?: Partial<TunnelStateView>
  // When set, the next `commit` will populate `currentPublicOrigin` with
  // this value and notify subscribers — simulating an immediate tunnel
  // acquire. Leave undefined to never resolve (lets timeouts fire).
  resolveTo?: string
}

interface MockTunnelHandle {
  store: TunnelStoreService
  commit: ReturnType<typeof vi.fn>
  state: TunnelStateView
}

const makeMockTunnel = (options: MockTunnelOptions = {}): MockTunnelHandle => {
  const state: TunnelStateView = {
    requestedPublicOrigin: options.initial?.requestedPublicOrigin ?? null,
    currentPublicOrigin: options.initial?.currentPublicOrigin ?? null,
  }
  type Subscriber = (state: TunnelStateView) => void
  const subscribers = new Set<Subscriber>()

  const commit = vi.fn((event: unknown): void => {
    const payload =
      typeof event === 'object' && event !== null && 'args' in event
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          (event as { args: { value: Partial<TunnelStateView> } }).args.value
        : undefined
    if (payload !== undefined) {
      if ('requestedPublicOrigin' in payload) {
        state.requestedPublicOrigin = payload.requestedPublicOrigin ?? null
      }
      if ('currentPublicOrigin' in payload) {
        state.currentPublicOrigin = payload.currentPublicOrigin ?? null
      }
    }
    if (options.resolveTo !== undefined && state.requestedPublicOrigin !== null) {
      state.currentPublicOrigin = options.resolveTo
    }
    for (const sub of subscribers) sub({ ...state })
  })

  const query = vi.fn((q: unknown): unknown => {
    if (q === tunnelQueries.current$) return { ...state }
    return undefined
  })

  const subscribe = vi.fn((q: unknown, cb: (value: unknown) => void) => {
    if (q !== tunnelQueries.current$) return () => undefined
    const wrapped: Subscriber = (s) => cb({ ...s })
    subscribers.add(wrapped)
    // Fire initial snapshot synchronously — mirrors livestore's
    // subscribe contract.
    wrapped(state)
    return () => {
      subscribers.delete(wrapped)
    }
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const store = { query, commit, subscribe } as unknown as TunnelStoreService
  return { store, commit, state }
}

// Identify a LiveQueryDef by its stable `hash`.
const queryHash = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

interface MockStoreOptions {
  rows?: ReadonlyArray<AppSelectionRow>
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
      for (const row of rowsArr) {
        if (livestoreQueries.appSelectionById$(row.id).hash === hash) {
          return byIdImpl(row.id)
        }
      }
      return undefined
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

const makeMockStoreWithDynamicById = (
  byIdImpl: (id: string) => AppSelectionRow | undefined
): AppsStoreService => {
  const knownIds = ['custom-1', 'custom-mystery']
  const query = vi.fn((q: unknown): unknown => {
    if (q === livestoreQueries.appSelection$) return []
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

interface CreateHandlerOptions {
  publicOrigin?: string
}

const createHandler = (
  store: AppsStoreService,
  tunnel: MockTunnelHandle,
  options: CreateHandlerOptions = {}
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const publicOriginValue = options.publicOrigin ?? 'https://tunnel.example.com'
  const publicOriginLayer = Layer.succeed(PublicOrigin, {
    get: Effect.succeed(publicOriginValue),
  })
  const apiLive = AppsApiLive.pipe(
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(Layer.succeed(TunnelStore, tunnel.store)),
    Layer.provide(publicOriginLayer)
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
    const { handler, dispose } = createHandler(makeMockStore(), makeMockTunnel())
    try {
      const response = await handler(new Request('http://localhost/apps/patient-browser'))
      if (response.status !== 302) {
        // oxlint-disable-next-line no-console
        console.error('DEBUG status:', response.status)
        // oxlint-disable-next-line no-console
        console.error(
          'DEBUG headers:',
          JSON.stringify(Object.fromEntries(response.headers.entries()))
        )
        // oxlint-disable-next-line no-console
        console.error(
          'DEBUG body bytes:',
          await response
            .clone()
            .arrayBuffer()
            .then((b) => b.byteLength)
        )
      }
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        'https://tunnel.example.com/installed-apps/patient-browser/index.html'
      )
    } finally {
      await dispose()
    }
  })

  it('redirects an action app (fhir-sharing) to the origin when tunnel is already up', async () => {
    const { handler, dispose } = createHandler(
      makeMockStore(),
      makeMockTunnel({ initial: { currentPublicOrigin: 'https://tunnel.example.com' } })
    )
    try {
      const response = await handler(new Request('http://localhost/apps/fhir-sharing'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://tunnel.example.com')
    } finally {
      await dispose()
    }
  })

  it('commits a request and waits for currentPublicOrigin before redirecting', async () => {
    const tunnel = makeMockTunnel({ resolveTo: 'https://tunnel.example.com' })
    const { handler, dispose } = createHandler(makeMockStore(), tunnel)
    try {
      const response = await handler(new Request('http://localhost/apps/growth-chart'))
      expect(tunnel.commit).toHaveBeenCalled()
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('https://examples.smarthealthit.org/growth-chart-app/launch.html')
      expect(location).toContain('iss=https://tunnel.example.com/fhir-r4')
    } finally {
      await dispose()
    }
  })

  it('falls back to PublicOrigin when the await times out', async () => {
    // `resolveTo` not set → mock never delivers currentPublicOrigin →
    // handler's awaitCurrentPublicOrigin hits its 15s timeout. We set
    // publicOrigin explicitly so we can assert the fallback path; the
    // longer runtime is accepted via the test's 20s timeout.
    const tunnel = makeMockTunnel()
    const { handler, dispose } = createHandler(makeMockStore(), tunnel, {
      publicOrigin: 'https://tunnel.example.com',
    })
    try {
      const response = await handler(new Request('http://localhost/apps/medication-viewer'))
      expect(tunnel.commit).toHaveBeenCalled()
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location).toContain('iss=https://tunnel.example.com/fhir-r4')
    } finally {
      await dispose()
    }
  }, 20_000)

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
    const { handler, dispose } = createHandler(store, makeMockTunnel())
    try {
      const response = await handler(new Request('http://localhost/apps/custom-1'))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://tunnel.example.com/some/path')
    } finally {
      await dispose()
    }
  })

  it('rejects a custom app whose resolved url is neither same-origin nor https://', async () => {
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

  it('returns 404 when a custom row exists before tunnel work but disappears mid-flight', async () => {
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
      return undefined
    }
    const store = makeMockStoreWithDynamicById(byIdImpl)
    const { handler, dispose } = createHandler(
      store,
      makeMockTunnel({ resolveTo: 'https://tunnel.example.com' })
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

import { HttpApiBuilder, HttpServer } from '@effect/platform'
import type { Store } from '@livestore/livestore'
import { Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  type AppSelectionRow,
  AppsStore,
  queries as livestoreQueries,
  type schema,
} from '../livestore/index.ts'
import { AppsAdminApiLive } from './index.ts'

// --- Mock store -------------------------------------------------------

type AppsStoreService = Store<typeof schema, object>

interface CommittedEvent {
  readonly name: string
  readonly args: Record<string, unknown>
}

const queryHash = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const readBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined
const readKind = (value: unknown): AppSelectionRow['kind'] | undefined =>
  value === 'bundled' || value === 'custom' || value === 'action' ? value : undefined

interface MockStoreOptions {
  rows?: ReadonlyArray<AppSelectionRow>
}

interface MockStoreHandle {
  store: AppsStoreService
  rows: Map<string, AppSelectionRow>
  committed: CommittedEvent[]
  /** Apply an event to the in-memory rows. Mirrors the materializer for
   * the cases `UpdateApp` exercises: `customAppUpdated`,
   * `appEnabledChanged`. */
  applyEvent: (event: CommittedEvent) => void
}

const makeMockStore = (options: MockStoreOptions = {}): MockStoreHandle => {
  const rows = new Map<string, AppSelectionRow>()
  for (const row of options.rows ?? []) {
    rows.set(row.id, row)
  }
  const committed: CommittedEvent[] = []

  type Subscriber = (row: AppSelectionRow | undefined) => void
  // Subscribers keyed by query hash → list of callbacks.
  const subscribers = new Map<string, Set<Subscriber>>()

  const findByHash = (hash: string): AppSelectionRow | undefined => {
    for (const row of rows.values()) {
      if (livestoreQueries.appSelectionById$(row.id).hash === hash) {
        return row
      }
    }
    return undefined
  }

  const applyEvent = (event: CommittedEvent): void => {
    if (event.name === 'v1.CustomAppUpdated') {
      const id = readString(event.args['id']) ?? ''
      const existing = rows.get(id)
      if (existing !== undefined && existing.kind === 'custom') {
        const nameArg = readString(event.args['name'])
        const urlArg = readString(event.args['url'])
        const requiresTunnelArg = readBoolean(event.args['requiresTunnel'])
        rows.set(id, {
          ...existing,
          ...(nameArg !== undefined && { customName: nameArg }),
          ...(urlArg !== undefined && { customUrl: urlArg }),
          ...(requiresTunnelArg !== undefined && {
            customRequiresTunnel: requiresTunnelArg,
          }),
        })
      }
    } else if (event.name === 'v1.AppEnabledChanged') {
      const id = readString(event.args['id']) ?? ''
      const existing = rows.get(id)
      const kind = readKind(event.args['kind']) ?? 'bundled'
      const enabled = readBoolean(event.args['enabled']) ?? true
      if (existing === undefined) {
        rows.set(id, {
          id,
          kind,
          enabled,
          customName: null,
          customUrl: null,
          customRequiresTunnel: null,
        })
      } else {
        rows.set(id, { ...existing, kind, enabled })
      }
    } else if (event.name === 'v1.CustomAppAdded') {
      const id = readString(event.args['id']) ?? ''
      rows.set(id, {
        id,
        kind: 'custom',
        enabled: true,
        customName: readString(event.args['name']) ?? '',
        customUrl: readString(event.args['url']) ?? '',
        customRequiresTunnel: readBoolean(event.args['requiresTunnel']) ?? false,
      })
    } else if (event.name === 'v1.CustomAppRemoved') {
      rows.delete(readString(event.args['id']) ?? '')
    }

    // Fan out to every subscriber whose hash currently resolves.
    for (const [hash, subs] of subscribers.entries()) {
      const row = findByHash(hash)
      for (const s of subs) s(row)
    }
  }

  const query = vi.fn((q: unknown): unknown => {
    if (q === livestoreQueries.appSelection$) {
      return [...rows.values()]
    }
    const hash = queryHash(q)
    if (hash !== undefined) return findByHash(hash)
    return undefined
  })

  const subscribe = vi.fn(
    (q: unknown, cb: (row: AppSelectionRow | undefined) => void): (() => void) => {
      const hash = queryHash(q)
      if (hash === undefined) return (): void => undefined
      let bucket = subscribers.get(hash)
      if (bucket === undefined) {
        bucket = new Set()
        subscribers.set(hash, bucket)
      }
      bucket.add(cb)
      // Defer the initial-value delivery to the next microtask. Production
      // `awaitRow` assigns `dispose` from `subscribe`'s return and then
      // *that closure* references `dispose` itself — synchronous callback
      // invocation would observe `dispose === undefined`. Mirrors the
      // pattern used in gatekeeper-core's `await-row.test.ts`.
      queueMicrotask(() => {
        if (!bucket?.has(cb)) return
        cb(findByHash(hash))
      })
      return (): void => {
        bucket?.delete(cb)
      }
    }
  )

  const commit = vi.fn((...events: ReadonlyArray<CommittedEvent>): void => {
    for (const event of events) {
      committed.push(event)
      applyEvent(event)
    }
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const store = {
    query,
    commit,
    subscribe,
  } as unknown as AppsStoreService

  return { store, rows, committed, applyEvent }
}

// --- Wire up ----------------------------------------------------------

const createHandler = (store: AppsStoreService): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AppsAdminApiLive.pipe(Layer.provide(AppsStore.layerFrom(store)))
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

// --- CreateCustomApp --------------------------------------------------

describe('CreateCustomApp handler', () => {
  it('commits a customAppAdded event and returns the new entry', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'My App',
            url: 'https://example.com/launch',
            requiresTunnel: true,
          }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as {
        id: string
        name: string
        subtitle: string
        requiresTunnel: boolean
        kind: string
        enabled: boolean
      }
      expect(body.kind).toBe('custom')
      expect(body.enabled).toBe(true)
      expect(body.name).toBe('My App')
      expect(body.subtitle).toBe('https://example.com/launch')
      expect(body.requiresTunnel).toBe(true)
      expect(body.id).toMatch(/^custom-/)

      // One event committed, of the expected shape.
      expect(handle.committed).toHaveLength(1)
      expect(handle.committed[0]?.name).toBe('v1.CustomAppAdded')
      expect(handle.committed[0]?.args).toMatchObject({
        name: 'My App',
        url: 'https://example.com/launch',
        requiresTunnel: true,
      })
    } finally {
      await dispose()
    }
  })
})

// --- UpdateApp --------------------------------------------------------

describe('UpdateApp handler', () => {
  it('renames a custom app and the response reflects the materialised row', async () => {
    const handle = makeMockStore({
      rows: [
        {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'Original',
          customUrl: 'https://example.com/v1',
          customRequiresTunnel: false,
        },
      ],
    })
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/custom-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as {
        id: string
        name: string
        subtitle: string
        kind: string
      }
      expect(body.id).toBe('custom-1')
      expect(body.name).toBe('Renamed')
      expect(body.subtitle).toBe('https://example.com/v1')
      expect(body.kind).toBe('custom')

      // The mock's `subscribe` is the path `awaitRow` relies on — assert
      // it was called for the byId$ query.
      expect(handle.store.subscribe).toHaveBeenCalled()

      // One commit for the customAppUpdated event.
      expect(handle.committed.map((c) => c.name)).toEqual(['v1.CustomAppUpdated'])
    } finally {
      await dispose()
    }
  })

  it('toggling enabled commits an appEnabledChanged event', async () => {
    const handle = makeMockStore({
      rows: [
        {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: 'https://example.com/launch',
          customRequiresTunnel: false,
        },
      ],
    })
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/custom-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { enabled: boolean }
      expect(body.enabled).toBe(false)
      expect(handle.committed.map((c) => c.name)).toEqual(['v1.AppEnabledChanged'])
      expect(handle.committed[0]?.args).toMatchObject({
        id: 'custom-1',
        kind: 'custom',
        enabled: false,
      })
    } finally {
      await dispose()
    }
  })

  it('updating a bundled app with name/url returns BundledAppImmutable', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/patient-browser', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        })
      )
      expect(response.status).toBe(403)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('BundledAppImmutable')
      expect(body.id).toBe('patient-browser')
      expect(handle.committed).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('disabling a bundled app commits an appEnabledChanged event with the bundled kind', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/patient-browser', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { id: string; kind: string; enabled: boolean }
      expect(body.id).toBe('patient-browser')
      expect(body.kind).toBe('bundled')
      expect(body.enabled).toBe(false)
      expect(handle.committed.map((c) => c.name)).toEqual(['v1.AppEnabledChanged'])
      expect(handle.committed[0]?.args).toMatchObject({
        id: 'patient-browser',
        kind: 'bundled',
        enabled: false,
      })
    } finally {
      await dispose()
    }
  })

  it('returns AppNotFound when neither a bundled nor a custom row exists', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/no-such-app', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      )
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

// --- DeleteApp --------------------------------------------------------

describe('DeleteApp handler', () => {
  it('returns BundledAppImmutable when the id is a bundled app', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/patient-browser', { method: 'DELETE' })
      )
      expect(response.status).toBe(403)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('BundledAppImmutable')
      expect(body.id).toBe('patient-browser')
      expect(handle.committed).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('returns AppNotFound when the id has no matching row', async () => {
    const handle = makeMockStore()
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/no-such-app', { method: 'DELETE' })
      )
      expect(response.status).toBe(404)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { error: string; id: string }
      expect(body.error).toBe('AppNotFound')
    } finally {
      await dispose()
    }
  })

  it('commits customAppRemoved and returns { deleted: true } for an existing custom app', async () => {
    const handle = makeMockStore({
      rows: [
        {
          id: 'custom-1',
          kind: 'custom',
          enabled: true,
          customName: 'My App',
          customUrl: 'https://example.com/launch',
          customRequiresTunnel: false,
        },
      ],
    })
    const { handler, dispose } = createHandler(handle.store)
    try {
      const response = await handler(
        new Request('http://localhost/apps/custom-1', { method: 'DELETE' })
      )
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = (await response.json()) as { deleted: boolean }
      expect(body.deleted).toBe(true)
      expect(handle.committed.map((c) => c.name)).toEqual(['v1.CustomAppRemoved'])
      expect(handle.committed[0]?.args).toMatchObject({ id: 'custom-1' })
    } finally {
      await dispose()
    }
  })
})

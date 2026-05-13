import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'
import { Schema } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { events, queries, schema } from './index.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

// --- Event-schema decoding (kept from the original suite so wire-shape
// regressions still get caught locally; the materializer-level checks
// below cover end-to-end behavior). ---------------------------------

describe('appEnabledChanged event', () => {
  it('decodes a valid payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(events.appEnabledChanged.schema)({
        id: 'patient-browser',
        kind: 'bundled',
        enabled: false,
      }),
      { id: 'patient-browser', kind: 'bundled', enabled: false }
    )
  })

  it('rejects an unknown kind', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(events.appEnabledChanged.schema)({
        id: 'x',
        kind: 'mystery',
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('customAppAdded event', () => {
  it('decodes a valid payload', () => {
    const payload = {
      id: 'custom-abc',
      name: 'My App',
      url: 'https://example.com/launch',
      requiresTunnel: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppAdded.schema)(payload), payload)
  })
})

describe('customAppUpdated event', () => {
  it('decodes a payload with only the id', () => {
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppUpdated.schema)({ id: 'x' }), {
      id: 'x',
    })
  })

  it('decodes partial updates', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(events.customAppUpdated.schema)({
        id: 'x',
        name: 'Renamed',
      }),
      { id: 'x', name: 'Renamed' }
    )
  })
})

describe('customAppRemoved event', () => {
  it('decodes a valid payload', () => {
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppRemoved.schema)({ id: 'x' }), {
      id: 'x',
    })
  })
})

// --- Materializer round-trip via an in-memory livestore --------------
// These tests boot a real `@livestore/adapter-node` in-memory store,
// commit a sequence of events, then assert the materialized rows match
// expectations via `queries.byId$` / `queries.all$`. The point is to
// catch regressions in the SQLite materializer mapping itself (and its
// `onConflict` semantics for `appEnabledChanged`), which the schema-
// decoding tests above cannot cover.

const makeFreshStore = async (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `apps-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

const withStore = async <T>(
  fn: (store: Store<typeof schema, object>) => Promise<T>
): Promise<T> => {
  const store = await makeFreshStore()
  try {
    return await fn(store)
  } finally {
    await store.shutdownPromise().catch(() => undefined)
  }
}

describe('app-selection materializer', () => {
  it('customAppAdded inserts a row visible via byId$', () =>
    withStore(async (store) => {
      store.commit(
        events.customAppAdded({
          id: 'custom-1',
          name: 'My App',
          url: 'https://example.com/launch',
          requiresTunnel: true,
        })
      )
      const row = store.query(queries.appSelectionById$('custom-1'))
      expect(row).toBeDefined()
      expect(row?.id).toBe('custom-1')
      expect(row?.kind).toBe('custom')
      expect(row?.enabled).toBe(true)
      expect(row?.customName).toBe('My App')
      expect(row?.customUrl).toBe('https://example.com/launch')
      expect(row?.customRequiresTunnel).toBe(true)
    }))

  it('customAppUpdated with a partial payload only updates the named fields', () =>
    withStore(async (store) => {
      store.commit(
        events.customAppAdded({
          id: 'custom-1',
          name: 'Original',
          url: 'https://example.com/v1',
          requiresTunnel: true,
        })
      )
      store.commit(
        events.customAppUpdated({
          id: 'custom-1',
          name: 'Renamed',
        })
      )
      const row = store.query(queries.appSelectionById$('custom-1'))
      expect(row?.customName).toBe('Renamed')
      // Other fields preserved because the update payload omitted them.
      expect(row?.customUrl).toBe('https://example.com/v1')
      expect(row?.customRequiresTunnel).toBe(true)
      expect(row?.enabled).toBe(true)
    }))

  it('appEnabledChanged for a bundled id upserts a row with kind=bundled, enabled=false', () =>
    withStore(async (store) => {
      store.commit(
        events.appEnabledChanged({
          id: 'patient-browser',
          kind: 'bundled',
          enabled: false,
        })
      )
      const row = store.query(queries.appSelectionById$('patient-browser'))
      expect(row).toBeDefined()
      expect(row?.kind).toBe('bundled')
      expect(row?.enabled).toBe(false)
      // Bundled rows don't carry custom-* fields.
      expect(row?.customName).toBeNull()
      expect(row?.customUrl).toBeNull()
      expect(row?.customRequiresTunnel).toBeNull()
    }))

  it('appEnabledChanged twice for the same bundled id replaces (does not duplicate) the row', () =>
    withStore(async (store) => {
      store.commit(
        events.appEnabledChanged({ id: 'patient-browser', kind: 'bundled', enabled: false })
      )
      store.commit(
        events.appEnabledChanged({ id: 'patient-browser', kind: 'bundled', enabled: true })
      )
      const all = store.query(queries.appSelection$)
      const matches = all.filter((row) => row.id === 'patient-browser')
      expect(matches).toHaveLength(1)
      expect(matches[0]?.enabled).toBe(true)
    }))

  it('customAppRemoved deletes the row', () =>
    withStore(async (store) => {
      store.commit(
        events.customAppAdded({
          id: 'custom-1',
          name: 'My App',
          url: 'https://example.com/launch',
          requiresTunnel: false,
        })
      )
      expect(store.query(queries.appSelectionById$('custom-1'))).toBeDefined()

      store.commit(events.customAppRemoved({ id: 'custom-1' }))
      expect(store.query(queries.appSelectionById$('custom-1'))).toBeUndefined()
    }))
})

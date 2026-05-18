import {
  Events,
  State,
  type Store as LivestoreStore,
  isLiveStoreSchema,
} from '@livestore/livestore'
import { Effect, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { defineSliceLivestore } from './index.ts'

// ---------------------------------------------------------------------------
// Minimal fixture: one table, one event, one materializer.
// ---------------------------------------------------------------------------

const counterTable = State.SQLite.table({
  name: 'counter',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.integer({ default: 0 }),
  },
})

const counterIncremented = Events.synced({
  name: 'v1.CounterIncremented',
  schema: Schema.Struct({ id: Schema.String, by: Schema.Number }),
})

const fixtureTables = { counter: counterTable }
const fixtureEvents = { counterIncremented }
const fixtureMaterializers = State.SQLite.materializers(fixtureEvents, {
  'v1.CounterIncremented': ({ id, by }) => counterTable.insert({ id, value: by }),
})

const makeSliceLs = <Name extends string>(
  name: Name
  // oxlint-disable-next-line typescript/explicit-function-return-type
) =>
  defineSliceLivestore({
    name,
    tables: fixtureTables,
    events: fixtureEvents,
    materializers: fixtureMaterializers,
  })

// A stub livestore Store — only the structural surface kitchen-sink needs
// to assert reference identity through the Layer.
interface StubStore {
  readonly __brand: 'fixture'
}
const makeStubStore = (): LivestoreStore<never, object> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ({ __brand: 'fixture' }) satisfies StubStore as unknown as LivestoreStore<never, object>

describe('defineSliceLivestore', () => {
  it('produces a Context.Tag whose key matches the supplied name', () => {
    const sliceLs = makeSliceLs('FixtureStore')
    class FixtureStore extends sliceLs.StoreTag<FixtureStore>() {}
    expect(FixtureStore.key).toBe('FixtureStore')
  })

  it('produces a valid LiveStoreSchema', () => {
    const sliceLs = makeSliceLs('FixtureStore')
    expect(isLiveStoreSchema(sliceLs.schema)).toBe(true)
  })

  it('schema forwards the supplied tables and events by reference', () => {
    const sliceLs = makeSliceLs('FixtureStore')
    // Reference identity (not just `.has(name)`): catches a regression
    // that swaps the supplied table/event for a different definition
    // with the same key.
    expect(sliceLs.state.sqlite.tables.get('counter')).toBe(counterTable)
    expect(sliceLs.schema.eventsDefsMap.get('v1.CounterIncremented')).toBe(counterIncremented)
  })

  it('accepts an empty schema (no tables, events, or materializers)', () => {
    const empty = defineSliceLivestore({
      name: 'Empty',
      tables: {},
      events: {},
      materializers: {},
    })
    expect(isLiveStoreSchema(empty.schema)).toBe(true)
    // Livestore injects internal tables of its own; the fixture
    // contributes none, so `eventsDefsMap` is the cleanest signal that
    // the supplied (empty) event set flowed through verbatim.
    expect(empty.schema.eventsDefsMap.size).toBe(0)
  })

  it('layerFrom resolves the same store reference back through the tag', async () => {
    const sliceLs = makeSliceLs('FixtureStore')
    class FixtureStore extends sliceLs.StoreTag<FixtureStore>() {}
    const stub = makeStubStore()

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* FixtureStore
      }).pipe(Effect.provide(sliceLs.makeLayerFactory(FixtureStore)(stub)))
    )

    expect(resolved).toBe(stub)
  })

  it('rejects a store whose schema is not a superset (type-level)', () => {
    const sliceLs = makeSliceLs('FixtureStore')
    class FixtureStore extends sliceLs.StoreTag<FixtureStore>() {}

    // A schema with no overlap — should not satisfy `TSchema extends typeof schema`.
    const unrelated = defineSliceLivestore({
      name: 'Unrelated',
      tables: {},
      events: {},
      materializers: {},
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const fakeUnrelatedStore = {} as unknown as LivestoreStore<typeof unrelated.schema, object>

    // @ts-expect-error — unrelated.schema is not a superset of sliceLs.schema
    sliceLs.makeLayerFactory(FixtureStore)(fakeUnrelatedStore)
  })

  it('Store.key matches the supplied name for arbitrary tag names', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
        (name) => {
          const sliceLs = defineSliceLivestore({
            name,
            tables: fixtureTables,
            events: fixtureEvents,
            materializers: fixtureMaterializers,
          })
          class FixtureStore extends sliceLs.StoreTag<FixtureStore>() {}
          expect(FixtureStore.key).toBe(name)
        }
      )
    )
  })
})

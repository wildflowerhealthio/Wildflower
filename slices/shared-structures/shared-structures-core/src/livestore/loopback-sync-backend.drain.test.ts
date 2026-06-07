import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, Events, makeSchema, Schema, State } from '@livestore/livestore'
import { LogLevel } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeLoopbackSyncBackend } from './loopback-sync-backend.ts'

// ---------------------------------------------------------------------------
// Minimal synced schema — one table, one *synced* upsert event, one
// materializer. The event must be `Events.synced` (not `clientOnly`): only
// synced events flow through the leader's backend push/pull path, which is
// the path whose `pending` the loopback exists to drain.
// ---------------------------------------------------------------------------

const items = State.SQLite.table({
  name: 'items',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
  },
})

const itemSet = Events.synced({
  name: 'v1.ItemSet',
  schema: Schema.Struct({ id: Schema.String, value: Schema.String }),
})

const events = { itemSet } as const

type ConflictTarget = Parameters<ReturnType<typeof items.insert>['onConflict']>[0]
// The `id` column is the conflict target, but the table generics don't expose
// the literal so the bare `'id'` can't satisfy `ConflictTarget`. Same narrow
// cast used in `tunnel-core/src/livestore/tunnel-config.ts`.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const idConflictColumn = 'id' as unknown as ConflictTarget

const materializers = State.SQLite.materializers(events, {
  'v1.ItemSet': ({ id, value }) =>
    items.insert({ id, value }).onConflict(idConflictColumn, 'replace'),
})

const schema = makeSchema({
  events,
  state: State.SQLite.makeState({ tables: { items }, materializers }),
})

const makeStore = (withLoopback: boolean): ReturnType<typeof createStorePromise<typeof schema>> =>
  createStorePromise({
    adapter: makeAdapter(
      withLoopback
        ? { storage: { type: 'in-memory' }, sync: { backend: makeLoopbackSyncBackend() } }
        : { storage: { type: 'in-memory' } }
    ),
    schema,
    storeId: `loopback-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    // LiveStore defaults to Debug in non-production envs; pin to Info to keep
    // the teardown debug noise down (matches `served-origin.test.ts`).
    logLevel: LogLevel.Info,
  })

// Poll a store's *leader* pending-event count (the queue that grows unbounded
// on a local-only store) until it satisfies `predicate`. Throws on timeout so
// a backend that never drains fails loudly instead of hanging.
const waitForLeaderPending = async (
  store: Awaited<ReturnType<typeof makeStore>>,
  predicate: (pendingCount: number) => boolean,
  timeoutMs = 10_000
): Promise<number> => {
  const start = Date.now()
  for (;;) {
    // `_dev` is LiveStore's @internal-but-public introspection handle; the
    // leader's `pending.length` is the queue this backend exists to drain.
    // oxlint-disable-next-line no-underscore-dangle
    const { leader } = await store._dev.syncStates()
    if (predicate(leader.pending.length)) {
      return leader.pending.length
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForLeaderPending: pending=${leader.pending.length} never satisfied predicate within ${timeoutMs}ms`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const EVENT_COUNT = 50

describe('makeLoopbackSyncBackend (drain)', () => {
  it('drains the leader pending queue to zero when the loopback backend is wired', async () => {
    const store = await makeStore(true)
    try {
      for (let i = 0; i < EVENT_COUNT; i++) {
        store.commit(itemSet({ id: `item-${i}`, value: `v${i}` }))
      }
      // The loopback echoes each pushed batch back on the leader's live pull;
      // the leader confirms them and clears `pending`.
      const drained = await waitForLeaderPending(store, (count) => count === 0)
      expect(drained).toBe(0)
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  it('leaves the leader pending unconfirmed without a sync backend', async () => {
    const store = await makeStore(false)
    try {
      for (let i = 0; i < EVENT_COUNT; i++) {
        store.commit(itemSet({ id: `item-${i}`, value: `v${i}` }))
      }
      // With no backend, nothing confirms the events: pending climbs to the
      // full backlog and stays there (this is the bug the loopback fixes). The
      // poll only ever reaches `EVENT_COUNT` if no draining occurred.
      const stuck = await waitForLeaderPending(store, (count) => count === EVENT_COUNT)
      expect(stuck).toBe(EVENT_COUNT)
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})

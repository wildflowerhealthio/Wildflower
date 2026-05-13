import type { Store } from '@livestore/livestore'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { schema } from '../livestore/index.ts'
import { CollectorStore, makeCollectorStoreLayer } from './collector-store.ts'

const makeStore = (): Store<typeof schema, object> => {
  const store = {
    query: vi.fn(),
    commit: vi.fn(),
    subscribe: vi.fn(),
  }

  // This test only needs the query/commit/subscribe surface used by
  // collector-core. Runtime behavior is validated by reference identity.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return store as unknown as Store<typeof schema, object>
}

describe('makeCollectorStoreLayer', () => {
  it('provides the same store reference via CollectorStore', async () => {
    const store = makeStore()

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* CollectorStore
      }).pipe(Effect.provide(makeCollectorStoreLayer(store)))
    )

    expect(resolved).toBe(store)
  })
})

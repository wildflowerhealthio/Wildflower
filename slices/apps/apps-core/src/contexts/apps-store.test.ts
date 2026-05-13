import type { Store } from '@livestore/livestore'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { schema } from '../livestore/index.ts'
import { AppsStore, makeAppsStoreLayer } from './apps-store.ts'

const makeStore = (): Store<typeof schema, object> => {
  const store = {
    query: vi.fn(),
    commit: vi.fn(),
    subscribe: vi.fn(),
  }

  // This test only needs the query/commit/subscribe surface used by
  // apps-core. Runtime behavior is validated by reference identity.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return store as unknown as Store<typeof schema, object>
}

describe('makeAppsStoreLayer', () => {
  it('provides the same store reference via AppsStore', async () => {
    const store = makeStore()

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AppsStore
      }).pipe(Effect.provide(makeAppsStoreLayer(store)))
    )

    expect(resolved).toBe(store)
  })
})

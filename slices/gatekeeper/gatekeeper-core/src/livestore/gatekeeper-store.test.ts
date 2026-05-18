import type { Store } from '@livestore/livestore'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { GatekeeperStore, type schema } from './index.ts'

describe('GatekeeperStore.layerFrom', () => {
  it('resolves the same store reference back through the tag', async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const stub = { __brand: 'fixture' } as unknown as Store<typeof schema, object>

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* GatekeeperStore
      }).pipe(Effect.provide(GatekeeperStore.layerFrom(stub)))
    )

    expect(resolved).toBe(stub)
  })
})

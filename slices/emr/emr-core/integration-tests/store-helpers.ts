import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'

import { schema } from '../src/livestore/index.ts'

const makeFreshStore = async (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

export { makeFreshStore, withStore }

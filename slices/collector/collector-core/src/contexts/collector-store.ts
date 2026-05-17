import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class CollectorStore extends Context.Tag('CollectorStore')<
  CollectorStore,
  Store<typeof schema, object>
>() {}

const makeCollectorStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
): Layer.Layer<CollectorStore, never, never> =>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
  Layer.succeed(CollectorStore, store as unknown as Store<typeof schema, object>)

export { CollectorStore, makeCollectorStoreLayer }

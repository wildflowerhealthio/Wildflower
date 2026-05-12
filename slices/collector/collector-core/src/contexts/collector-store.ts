import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class CollectorStore extends Context.Tag('CollectorStore')<
  CollectorStore,
  Store<typeof schema, object>
>() {}

const makeCollectorStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
): Layer.Layer<CollectorStore> => Layer.succeed(CollectorStore, store as Store<any, object>)

export { CollectorStore, makeCollectorStoreLayer }

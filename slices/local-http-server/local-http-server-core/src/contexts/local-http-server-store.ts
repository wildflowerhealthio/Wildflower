import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class LocalHttpServerStore extends Context.Tag('local-http-server-core/LocalHttpServerStore')<
  LocalHttpServerStore,
  Store<typeof schema, object>
>() {}

const makeLocalHttpServerStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
): Layer.Layer<LocalHttpServerStore, never, never> =>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
  Layer.succeed(LocalHttpServerStore, store as unknown as Store<typeof schema, object>)

export { LocalHttpServerStore, makeLocalHttpServerStoreLayer }

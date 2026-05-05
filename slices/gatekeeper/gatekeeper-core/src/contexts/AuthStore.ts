import type { Store } from '@livestore/livestore'
import { Context, Layer } from 'effect'
import type { schema } from '../livestore/index.ts'

class AuthStore extends Context.Tag('AuthStore')<AuthStore, Store<typeof schema, object>>() {}

const makeAuthStoreLayer = <TSchema extends typeof schema>(
  store: Store<TSchema, object>
  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
): Layer.Layer<AuthStore> => Layer.succeed(AuthStore, store as Store<any, object>)

export { AuthStore, makeAuthStoreLayer }

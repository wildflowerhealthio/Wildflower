import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/jwks.ts'
import { JsonWebKeys } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(AuthApi, 'auth-well-known', (handlers) =>
  handlers.handle('JwksJson', () =>
    Effect.gen(function* () {
      const store = yield* AuthStore
      const jsonWebKeys = store.query(JsonWebKeys.queries.allJwks$)
      return { keys: jsonWebKeys.map((jwk) => jwk.publicJwk()) }
    })
  )
)

export { httpApiGroup, layer }

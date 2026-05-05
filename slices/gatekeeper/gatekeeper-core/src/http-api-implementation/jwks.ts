import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/jwks.ts'
import { SigningKeys } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth-discovery', (handlers) =>
  handlers.handle('JwksJson', () =>
    Effect.gen(function* () {
      const store = yield* GatekeeperStore
      const signingKeys = store.query(SigningKeys.queries.all$)
      return { keys: signingKeys.map((jwk) => jwk.publicJwk()) }
    })
  )
)

export { httpApiGroup, layer }

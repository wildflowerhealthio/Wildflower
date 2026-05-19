import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { CryptoRandom } from 'kitchen-sink/crypto-random'
import type { Origin } from 'navigation-core'
import { apiHandlersFor } from 'shared-structures-core/http-api-implementation'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import type { GatekeeperStore } from '../livestore/index.ts'
import * as AccessManagement from './access-management.ts'
import * as Devices from './devices.ts'
import * as Jwks from './jwks.ts'
import * as OAuthConsent from './oauth-consent.ts'
import * as OAuth from './oauth/index.ts'
import { RequireAuthMiddlewareLive } from './require-auth.ts'
const GatekeeperApiHandlersLive = Layer.mergeAll(
  Jwks.layer,
  OAuth.layer,
  OAuthConsent.layer,
  AccessManagement.layer,
  Devices.layer
).pipe(Layer.provide(RequireAuthMiddlewareLive))

const GatekeeperApiLive = HttpApiBuilder.api(GatekeeperApi).pipe(
  Layer.provide(GatekeeperApiHandlersLive)
)

const GatekeeperApiHandlersFor = apiHandlersFor<
  'GatekeeperApi',
  ['oauth-discovery', 'oauth', 'oauth-consent', 'access-management', 'devices'],
  never,
  GatekeeperStore | Origin | CryptoRandom
>(GatekeeperApiHandlersLive)

export { GatekeeperApi, GatekeeperApiHandlersLive, GatekeeperApiHandlersFor, GatekeeperApiLive }
export { RequireAuthMiddleware, RequireAuthMiddlewareLive } from './require-auth.ts'

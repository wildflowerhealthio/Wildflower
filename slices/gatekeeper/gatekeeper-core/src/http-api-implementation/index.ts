import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { Origin } from 'kitchen-sink'
import type { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import type { OAuthDisplayDefault } from '../contexts/oauth-display-default.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import * as Devices from './devices.ts'
import * as GatekeeperAccess from './gatekeeper-access.ts'
import * as Jwks from './jwks.ts'
import * as OAuthConsent from './oauth-consent.ts'
import * as OAuth from './oauth.ts'
import * as PinLogin from './pin-login.ts'
import * as PinVerification from './pin-verification.ts'
import { RequireAuthMiddlewareLive } from './require-auth.ts'

const GatekeeperApiHandlersLive = Layer.mergeAll(
  Jwks.layer,
  OAuth.layer,
  PinLogin.layer,
  OAuthConsent.layer,
  PinVerification.layer,
  GatekeeperAccess.layer,
  Devices.layer
).pipe(Layer.provide(RequireAuthMiddlewareLive))

const GatekeeperApiLive = HttpApiBuilder.api(GatekeeperApi).pipe(
  Layer.provide(GatekeeperApiHandlersLive)
)

type GatekeeperGroupNames =
  | 'oauth-discovery'
  | 'oauth'
  | 'pin-login'
  | 'oauth-consent'
  | 'pin-verification'
  | 'gatekeeper-access'
  | 'devices'

const GatekeeperApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, GatekeeperGroupNames>,
  never,
  GatekeeperStore | Origin | OAuthDisplayDefault
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // GatekeeperApi is sound to satisfy the same group requirement under any
  // consumer's parent ApiId. This cast is the one place that bridge lives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  GatekeeperApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, GatekeeperGroupNames>,
    never,
    GatekeeperStore | Origin | OAuthDisplayDefault
  >

export { GatekeeperApi, GatekeeperApiHandlersLive, GatekeeperApiHandlersFor, GatekeeperApiLive }
export {
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
  requireAuthOrRedirect,
} from './require-auth.ts'

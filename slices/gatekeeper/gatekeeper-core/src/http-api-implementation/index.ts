import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { Origin } from 'kitchen-sink'
import { AuthListenersLive } from '../contexts/AuthListeners.ts'
import type { AuthRenderer } from '../contexts/AuthRenderer.ts'
import { AuthStateLive } from '../contexts/AuthState.ts'
import type { AuthStore } from '../contexts/AuthStore.ts'
import type { OAuthDisplayDefault } from '../contexts/OAuthDisplayDefault.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import * as AuthorizationRequest from './authorization-request.ts'
import * as Dashboard from './dashboard.ts'
import * as Jwks from './jwks.ts'
import * as OAuth from './oauth.ts'
import * as Pin from './pin.ts'

const AuthApiHandlersLive = Layer.mergeAll(
  Jwks.layer,
  OAuth.layer,
  Pin.layer,
  AuthorizationRequest.layer,
  Dashboard.layer
).pipe(Layer.provide(AuthListenersLive), Layer.provide(AuthStateLive))

const AuthApiLive = HttpApiBuilder.api(AuthApi).pipe(Layer.provide(AuthApiHandlersLive))

type AuthGroupNames =
  | 'auth-well-known'
  | 'oauth'
  | 'pin'
  | 'authorization-request'
  | 'auth-dashboard'

const AuthApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, AuthGroupNames>,
  never,
  AuthRenderer | AuthStore | Origin | OAuthDisplayDefault
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // AuthApi is sound to satisfy the same group requirement under any
  // consumer's parent ApiId. This cast is the one place that bridge lives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  AuthApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, AuthGroupNames>,
    never,
    AuthRenderer | AuthStore | Origin | OAuthDisplayDefault
  >

export { AuthApi, AuthApiHandlersLive, AuthApiHandlersFor, AuthApiLive }
export {
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
  requireAuthOrRedirect,
} from './require-auth.ts'

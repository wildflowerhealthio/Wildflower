import { HttpApi } from '@effect/platform'
import * as AuthorizationRequest from './authorization-request.ts'
import * as Dashboard from './dashboard.ts'
import * as Jwks from './jwks.ts'
import * as OAuth from './oauth.ts'
import * as Pin from './pin.ts'

const AuthApi = HttpApi.make('AuthApi')
  .add(Jwks.httpApiGroup)
  .add(OAuth.httpApiGroup)
  .add(Pin.httpApiGroup)
  .add(AuthorizationRequest.httpApiGroup)
  .add(Dashboard.httpApiGroup)

export { AuthApi, AuthorizationRequest, Dashboard, Jwks, OAuth, Pin }

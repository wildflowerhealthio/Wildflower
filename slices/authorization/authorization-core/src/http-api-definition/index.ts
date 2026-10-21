import { HttpApi } from '@effect/platform'
import * as AccessManagement from './access-management.ts'
import * as Devices from './devices.ts'
import * as Jwks from './jwks.ts'
import * as OAuthConsent from './oauth-consent.ts'
import * as OAuth from './oauth.ts'
import * as SessionWidenings from './session-widenings.ts'

const AuthorizationServerApi = HttpApi.make('AuthorizationServerApi')
  .add(Jwks.httpApiGroup)
  .add(OAuth.httpApiGroup)
  .add(OAuthConsent.httpApiGroup)
  .add(AccessManagement.httpApiGroup)
  .add(Devices.httpApiGroup)
  .add(SessionWidenings.httpApiGroup)

export {
  AuthorizationServerApi,
  AccessManagement,
  Devices,
  Jwks,
  OAuth,
  OAuthConsent,
  SessionWidenings,
}

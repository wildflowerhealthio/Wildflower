import { HttpApi } from '@effect/platform'
import * as AccessManagement from './access-management.ts'
import * as Devices from './devices.ts'
import * as Jwks from './jwks.ts'
import * as OAuthConsent from './oauth-consent.ts'
import * as OAuth from './oauth.ts'

const GatekeeperApi = HttpApi.make('GatekeeperApi')
  .add(Jwks.httpApiGroup)
  .add(OAuth.httpApiGroup)
  .add(OAuthConsent.httpApiGroup)
  .add(AccessManagement.httpApiGroup)
  .add(Devices.httpApiGroup)

export { GatekeeperApi, AccessManagement, Devices, Jwks, OAuth, OAuthConsent }

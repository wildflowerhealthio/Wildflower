import { HttpApi } from '@effect/platform'
import * as GatekeeperAccess from './gatekeeper-access.ts'
import * as Jwks from './jwks.ts'
import * as OAuthConsent from './oauth-consent.ts'
import * as OAuth from './oauth.ts'
import * as Pages from './pages.ts'
import * as PinLogin from './pin-login.ts'
import * as PinVerification from './pin-verification.ts'

const GatekeeperApi = HttpApi.make('GatekeeperApi')
  .add(Jwks.httpApiGroup)
  .add(OAuth.httpApiGroup)
  .add(PinLogin.httpApiGroup)
  .add(OAuthConsent.httpApiGroup)
  .add(PinVerification.httpApiGroup)
  .add(GatekeeperAccess.httpApiGroup)
  .add(Pages.httpApiGroup)

export {
  GatekeeperApi,
  GatekeeperAccess,
  Jwks,
  OAuth,
  OAuthConsent,
  Pages,
  PinLogin,
  PinVerification,
}

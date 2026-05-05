import { HttpApiError, HttpApiMiddleware, HttpApiSecurity } from '@effect/platform'

const BearerTokenSecurity = HttpApiSecurity.bearer
const SessionCookieSecurity = HttpApiSecurity.apiKey({
  key: '__wildflower_session',
  in: 'cookie',
})

class RequireAuthMiddleware extends HttpApiMiddleware.Tag<RequireAuthMiddleware>()(
  'RequireAuthMiddleware',
  {
    failure: HttpApiError.Unauthorized,
    security: {
      bearer: BearerTokenSecurity,
      session: SessionCookieSecurity,
    },
  }
) {}

export { RequireAuthMiddleware, BearerTokenSecurity, SessionCookieSecurity }

import { HttpApiError, HttpApiMiddleware, HttpApiSecurity } from '@effect/platform'

const BearerTokenSecurity = HttpApiSecurity.bearer

class RequireAuthMiddleware extends HttpApiMiddleware.Tag<RequireAuthMiddleware>()(
  'RequireAuthMiddleware',
  {
    failure: HttpApiError.Unauthorized,
    security: {
      bearer: BearerTokenSecurity,
    },
  }
) {}

export { RequireAuthMiddleware, BearerTokenSecurity }

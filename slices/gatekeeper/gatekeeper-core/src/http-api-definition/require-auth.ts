import { HttpApiError, HttpApiMiddleware, HttpApiSecurity } from '@effect/platform'
import { Schema } from 'effect'

const BearerTokenSecurity = HttpApiSecurity.bearer

class RequireAuthMiddleware extends HttpApiMiddleware.Tag<RequireAuthMiddleware>()(
  'RequireAuthMiddleware',
  {
    failure: Schema.Union(HttpApiError.Unauthorized, HttpApiError.InternalServerError),
    security: {
      bearer: BearerTokenSecurity,
    },
  }
) {}

export { RequireAuthMiddleware, BearerTokenSecurity }

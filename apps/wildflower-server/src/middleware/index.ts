import { HttpMiddleware } from '@effect/platform'
import { pipe } from 'effect'

import { accessLogMiddleware } from './access-log-middleware.ts'
import { corsMiddleware } from './cors-middleware.ts'
import { loopbackGateMiddleware } from './loopback-gate-middleware.ts'
import { stripCookiesMiddleware } from './strip-cookies-middleware.ts'

const middleware = HttpMiddleware.make((app) =>
  pipe(app, corsMiddleware, stripCookiesMiddleware, loopbackGateMiddleware, accessLogMiddleware)
)

export { middleware }

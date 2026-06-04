import { HttpMiddleware } from '@effect/platform'
import { pipe } from 'effect'

import { accessLogMiddleware } from './accessLogMiddleware.ts'
import { corsMiddleware } from './corsMiddleware.ts'
import { loopbackGateMiddleware } from './loopbackGateMiddleware.ts'
import { stripCookiesMiddleware } from './stripCookiesMiddleware.ts'

const middleware = HttpMiddleware.make((app) =>
  pipe(app, corsMiddleware, stripCookiesMiddleware, loopbackGateMiddleware, accessLogMiddleware)
)

export { middleware }

import { Headers, HttpServerRequest } from '@effect/platform'
import { Layer } from 'effect'

// Stubs the incoming request as a loopback peer with no host/forwarded
// headers, so the origin trust gate (`requestOriginFromHttpRequest`)
// trusts it and — finding no headers to derive from — returns the
// separately-provided `Origin` fallback. Lets tests assert against a
// fixed origin without each wiring its own header/peer story.
const LoopbackRequestLive: Layer.Layer<HttpServerRequest.HttpServerRequest> = Layer.succeed(
  HttpServerRequest.HttpServerRequest,
  HttpServerRequest.fromWeb(new Request('http://test.invalid/')).modify({
    headers: Headers.fromInput({}),
    remoteAddress: '127.0.0.1',
  })
)

export { LoopbackRequestLive }

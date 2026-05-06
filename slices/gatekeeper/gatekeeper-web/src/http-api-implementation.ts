import { type HttpApiGroup, HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { type Effect, Layer } from 'effect'
import { html } from 'gatekeeper-web/html'
import { GatekeeperWebApi } from './http-api.ts'

const serveHtml = (): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.html(html)

const uiLayer = HttpApiBuilder.group(GatekeeperWebApi, 'gatekeeper-web', (handlers) =>
  handlers
    .handleRaw('GetAuthUi', serveHtml)
    .handleRaw('GetAuthUiRequests', serveHtml)
    .handleRaw('GetAuthUiRequest', serveHtml)
    .handleRaw('GetAuthUiApproved', serveHtml)
    .handleRaw('GetAuthUiAuthorizationRequest', serveHtml)
)

const GatekeeperWebApiHandlersLive = uiLayer

const GatekeeperWebApiLive = HttpApiBuilder.api(GatekeeperWebApi).pipe(
  Layer.provide(GatekeeperWebApiHandlersLive)
)

type GatekeeperWebGroupNames = 'gatekeeper-web'

const GatekeeperWebApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, GatekeeperWebGroupNames>
> =>
  // Phantom-id bridge (see gatekeeper-core's AuthApiHandlersFor): a Layer built
  // against GatekeeperWebApi satisfies a parent ApiId's group requirement because
  // `ApiGroup<ApiId, Name>` is a structural marker with no runtime presence.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  GatekeeperWebApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, GatekeeperWebGroupNames>
  >

export { GatekeeperWebApiHandlersFor, GatekeeperWebApiHandlersLive, GatekeeperWebApiLive }

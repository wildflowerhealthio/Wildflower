import {
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
  type HttpApi,
  type HttpApiGroup,
} from '@effect/platform'
import { Context, Effect, Layer } from 'effect'
import type { Simplify } from 'effect/Types'
import { BearerToken } from 'kitchen-sink/auth-token'

/**
 * Auth mode for {@link defineSliceHttpClient}. `'bearer'` attaches
 * `Authorization: Bearer <token>` on every request via a `BearerToken`
 * Subscribable read per request; `'none'` builds a tokenless layer.
 */
type SliceHttpClientAuth = 'bearer' | 'none'

/**
 * Layer requirements that the helper-produced layer leaves unprovided,
 * keyed on the {@link SliceHttpClientAuth} mode the slice declared.
 */
type LayerRequirementsFor<AuthType extends SliceHttpClientAuth> = AuthType extends 'bearer'
  ? HttpClient.HttpClient | BearerToken
  : HttpClient.HttpClient

/**
 * Bundle a slice's HTTP client boilerplate into one declaration.
 *
 * Mirrors `defineSliceLivestore`: takes the slice-supplied `HttpApi`
 * value plus its desired auth mode and returns a `ClientTag<Self>()`
 * factory and a `makeLayerFactory(Tag)` that yields the slice's client
 * layer. The slice extends `ClientTag<Self>()` so its class name
 * (`TunnelAdminHttpApiClient`, etc.) remains both a value and a type
 * alias, exactly like the standalone
 * `class X extends Context.Tag(name)<X, Service>() {}` pattern.
 *
 *  - `ClientTag<Self>()` returns the result of
 *    `Context.Tag(name)<Self, ResolvedClientShape>()`, where
 *    `ResolvedClientShape` is `HttpApiClient.Client<Groups, ApiError, never>`
 *    derived from the input `HttpApi`. Slices extend this so the class
 *    name doubles as the tag identifier.
 *  - `makeLayerFactory(Tag)` returns a `() => Layer<Self, never, …>`. The
 *    requirements channel narrows on the declared auth mode:
 *     - `'bearer'` → `HttpClient.HttpClient | BearerToken` (reads the
 *       token via `Subscribable.get` per request; rotation surfaces on
 *       the next call without rebuilding the layer).
 *     - `'none'`   → `HttpClient.HttpClient` (no `Authorization` header).
 *
 * @example
 * ```ts
 * import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'
 *
 * const { ClientTag, makeLayerFactory, authType } = defineSliceHttpClient({
 *   name: 'TunnelAdminHttpApiClient',
 *   api: TunnelAdminApi,
 *   authType: 'bearer',
 * })
 *
 * class TunnelAdminHttpApiClient extends ClientTag<TunnelAdminHttpApiClient>() {
 *   static readonly layer = makeLayerFactory(TunnelAdminHttpApiClient)()
 *   static readonly authType = authType
 * }
 *
 * export { TunnelAdminHttpApiClient }
 * ```
 */
const defineSliceHttpClient = <
  const Name extends string,
  ApiId extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  ApiError,
  ApiR,
  const AuthType extends SliceHttpClientAuth,
>(input: {
  readonly name: Name
  readonly api: HttpApi.HttpApi<ApiId, Groups, ApiError, ApiR>
  readonly authType: AuthType
  // Explicit return type would have to re-express the derived Tag /
  // factory shapes; existing slice helpers (`defineSliceLivestore`,
  // `apps-core/src/livestore/app-selection.ts`) take the same
  // inferred-return approach.
  // oxlint-disable-next-line typescript/explicit-function-return-type
}) => {
  type Shape = Simplify<HttpApiClient.Client<Groups, ApiError, never>>

  // No explicit return type: forwarding the concrete
  // `Context.Tag(name)<Self, Shape>()` result preserves the static
  // `.Service` / `.Identifier` accessors that callers reach for via
  // `typeof MyTag.Service`. Annotating with the bare
  // `Context.TagClass<Self, Name, Shape>` interface strips those.
  // oxlint-disable-next-line typescript/explicit-function-return-type
  const ClientTag = <Self>() => Context.Tag(input.name)<Self, Shape>()

  const makeLayerFactory =
    <Self>(Tag: Context.Tag<Self, Shape>) =>
    (): Layer.Layer<Self, never, LayerRequirementsFor<AuthType>> => {
      if (input.authType === 'bearer') {
        const built = Layer.effect(
          Tag,
          Effect.gen(function* () {
            const tokenSubscribable = yield* BearerToken
            return yield* HttpApiClient.make(input.api, {
              baseUrl: '/',
              transformClient: (c) =>
                HttpClient.mapRequestEffect(c, (request) =>
                  Effect.gen(function* () {
                    const token = yield* tokenSubscribable.get
                    yield* Effect.logDebug(
                      `[${input.name}] bearer-attach: ${token === null ? 'NO TOKEN' : `token len=${token.length}`} ${request.method} ${request.url}`
                    )
                    return token === null
                      ? request
                      : HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
                  })
                ),
            })
          })
        )
        // The runtime branch picks between two concrete layer shapes
        // (`Layer<Self, never, HttpClient | BearerToken>` and
        // `Layer<Self, never, HttpClient>`); TS can't narrow
        // `LayerRequirementsFor<AuthType>` from the `input.authType === 'bearer'`
        // value check, so the single conditional cast lives here.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return built as unknown as Layer.Layer<Self, never, LayerRequirementsFor<AuthType>>
      }
      const built = Layer.effect(Tag, HttpApiClient.make(input.api, { baseUrl: '/' }))
      // Paired with the bearer-branch cast above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return built as unknown as Layer.Layer<Self, never, LayerRequirementsFor<AuthType>>
    }

  return { ClientTag, makeLayerFactory, authType: input.authType } as const
}

export { defineSliceHttpClient }
export type { LayerRequirementsFor, SliceHttpClientAuth }

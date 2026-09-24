import { HttpApiClient, type HttpApi, type HttpApiGroup, type HttpClient } from '@effect/platform'
import { Context, Layer } from 'effect'
import type { Simplify } from 'effect/Types'

/**
 * Bundle a slice's HTTP client boilerplate into one declaration.
 *
 * Takes the slice-supplied `HttpApi`
 * value and returns a `ClientTag<Self>()` factory and a
 * `makeLayerFactory(Tag)` that yields the slice's client layer. The
 * slice extends `ClientTag<Self>()` so its class name
 * (`TunnelAdminHttpApiClient`, etc.) remains both a value and a type
 * alias, exactly like the standalone
 * `class X extends Context.Tag(name)<X, Service>() {}` pattern.
 *
 *  - `ClientTag<Self>()` returns the result of
 *    `Context.Tag(name)<Self, ResolvedClientShape>()`, where
 *    `ResolvedClientShape` is `HttpApiClient.Client<Groups, ApiError, never>`
 *    derived from the input `HttpApi`. Slices extend this so the class
 *    name doubles as the tag identifier.
 *  - `makeLayerFactory(Tag)` returns a
 *    `() => Layer<Self, never, HttpClient.HttpClient>`. The client is
 *    tokenless — it sets no `Authorization` header. The host app's
 *    `HttpClient` layer decides how requests authenticate (a bearer the
 *    app attaches itself, or a host that authenticates them for it).
 *
 * @example
 * ```ts
 * import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'
 *
 * const { ClientTag, makeLayerFactory } = defineSliceHttpClient({
 *   name: 'TunnelAdminHttpApiClient',
 *   api: TunnelAdminApi,
 * })
 *
 * class TunnelAdminHttpApiClient extends ClientTag<TunnelAdminHttpApiClient>() {
 *   static readonly layer = makeLayerFactory(TunnelAdminHttpApiClient)()
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
>(input: {
  readonly name: Name
  readonly api: HttpApi.HttpApi<ApiId, Groups, ApiError, ApiR>
  // Explicit return type would have to re-express the derived Tag /
  // factory shapes, so this takes the inferred-return approach.
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
    (): Layer.Layer<Self, never, HttpClient.HttpClient> => {
      // No `baseUrl`: endpoint paths are already absolute-path relative
      // (`/x`), so a `'/'` base is a no-op at best — and `HttpApiClient`'s
      // base prepend runs *after* any transform the app layered onto the
      // context `HttpClient`, so it corrupts URLs when an app-level origin
      // prepend (e.g. the Tauri entry's `apiBaseUrl`) already made them
      // absolute (`/http://127.0.0.1:8080/x`).
      const built = Layer.effect(Tag, HttpApiClient.make(input.api))
      // `HttpApiClient.make`'s requirement is
      // `HttpClient | HttpApiMiddleware.Without<ApiR | ClientContext<Groups>>`.
      // For a concrete slice API that residual middleware client-context
      // reduces to `never` (the security is self-provided), leaving just
      // `HttpClient`; but TS can't prove that reduction for the unbounded
      // generic `Groups` here, so it can't narrow the layer's requirement
      // channel on its own. Concrete slice clients that call
      // `HttpApiClient.make` directly (e.g. the bespoke tunnel/databases
      // builders) typecheck to `HttpClient` without a cast — this single
      // narrowing exists only to bridge the generic-inference gap.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return built as Layer.Layer<Self, never, HttpClient.HttpClient>
    }

  return { ClientTag, makeLayerFactory } as const
}

export { defineSliceHttpClient }
export {
  InsufficientScopeSchema,
  isInsufficientScopeBody,
  type InsufficientScope,
} from './insufficient-scope.ts'

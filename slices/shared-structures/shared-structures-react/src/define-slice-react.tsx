// `defineSliceReact` is a factory that *returns* a React component +
// hooks; the file exports a function, not a component. The
// fast-refresh rule's "only export components" check fires on the
// inner `ClientProvider` declaration anyway, so disable it at the
// file level rather than reshuffling the helper to dodge the false
// positive.
/* oxlint-disable react/only-export-components */
import { type HttpClient } from '@effect/platform'
import { type Context, type Effect, Layer, type Scope, type Stream } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { createContext, type JSX, type PropsWithChildren, useContext, useMemo } from 'react'
import {
  type EffectAction,
  useAuthTokenSubscribable,
  useEffectAction as useKitchenSinkEffectAction,
  useEffectTs as useKitchenSinkEffectTs,
  useStream as useKitchenSinkStream,
} from 'react-kitchen-sink'
import type { SliceHttpClientAuth } from 'shared-structures-core/http-api-definition'

/**
 * Layer requirements the slice's client layer leaves unprovided,
 * paralleling `shared-structures-core/http-api-definition`'s
 * `LayerRequirementsFor`. Re-declared so this package doesn't need to
 * re-export the type from the core helper.
 */
type SliceClientLayerRequirements<AuthType extends SliceHttpClientAuth> = AuthType extends 'bearer'
  ? HttpClient.HttpClient | BearerToken
  : HttpClient.HttpClient

/**
 * Result of fully providing the slice's client layer. App-level code
 * (e.g. `useAllClientsLayer`) consumes this shape directly. The
 * requirements channel narrows on `AuthType`:
 *  - `'bearer'` → `Self | HttpClient.HttpClient | BearerToken` provided.
 *  - `'none'`   → `Self | HttpClient.HttpClient` provided; `BearerToken`
 *    is never read, so public-mode slices don't transitively require
 *    `<AuthTokenProvider>`.
 */
type FullyProvidedSliceLayer<Self, AuthType extends SliceHttpClientAuth> = AuthType extends 'bearer'
  ? Layer.Layer<Self | HttpClient.HttpClient | BearerToken, never, never>
  : Layer.Layer<Self | HttpClient.HttpClient, never, never>

/**
 * Bundle the React surface for a slice's HTTP client into one
 * declaration. Pair with `defineSliceHttpClient` from
 * `shared-structures-core/http-api-definition`: the slice's client tag,
 * layer, auth flag, and host's `HttpClient.HttpClient` layer flow in,
 * and the helper returns a context, a provider, and the four hooks
 * every slice-react package was hand-rolling.
 *
 *  - `ClientLayerContext`: a `Context<Layer | null>` whose value is the
 *    slice's unprovided client layer. App-level code reads it via
 *    `useClientLayer` and composes with other slices in
 *    `useAllClientsLayer`.
 *  - `ClientProvider`: a tiny React provider that hands the layer to
 *    `ClientLayerContext`. Singleton — built once at factory time and
 *    reused across every mount.
 *  - `useClientLayer`: returns the slice layer with `httpClientLayer`
 *    merged in, plus (for `authType: 'bearer'`)
 *    `Layer.succeed(BearerToken, useAuthTokenSubscribable())`. The
 *    implementation is selected at factory time on `authType`, so
 *    public-mode slices never call `useAuthTokenSubscribable` and
 *    therefore don't require `<AuthTokenProvider>` upstream.
 *  - `useEffectTs` / `useEffectAction` / `useStream`: thin wrappers
 *    around the kitchen-sink hooks, auto-providing the slice layer so
 *    screens can construct an Effect/Stream against the tag and run it.
 *
 * @example bearer-mode slice (admin client behind `RequireAuth`)
 * ```tsx
 * const {
 *   ClientLayerContext: TunnelAdminClientLayerContext,
 *   ClientProvider: TunnelClientProvider,
 *   useClientLayer: useTunnelAdminClientLayer,
 *   useEffectTs: useTunnelAdminEffect,
 *   useEffectAction: useTunnelAdminEffectAction,
 *   useStream: useTunnelAdminStream,
 * } = defineSliceReact({
 *   ClientTag: TunnelAdminHttpApiClient,
 *   layer: TunnelAdminHttpApiClient.layer,
 *   authType: TunnelAdminHttpApiClient.authType,
 *   httpClientLayer: webHttpClientLayer,
 *   contextName: 'Tunnel',
 * })
 * ```
 *
 * @example public-mode slice (no bearer token, no `<AuthTokenProvider>`
 * required upstream)
 * ```tsx
 * const {
 *   ClientLayerContext: AppsClientLayerContext,
 *   ClientProvider: AppsClientProvider,
 *   useClientLayer: useAppsClientLayer,
 *   useEffectTs: useAppsEffect,
 *   useEffectAction: useAppsEffectAction,
 *   useStream: useAppsStream,
 * } = defineSliceReact({
 *   ClientTag: AppsHttpApiClient,
 *   layer: AppsHttpApiClient.layer,
 *   authType: AppsHttpApiClient.authType, // 'none'
 *   httpClientLayer: webHttpClientLayer,
 *   contextName: 'Apps',
 * })
 * // useAppsClientLayer's return type is Layer<AppsHttpApiClient | HttpClient.HttpClient, never, never> —
 * // BearerToken is absent because the public branch never references it.
 * ```
 */
const defineSliceReact = <Self, Shape, AuthType extends SliceHttpClientAuth>(input: {
  readonly ClientTag: Context.Tag<Self, Shape>
  readonly layer: Layer.Layer<Self, never, SliceClientLayerRequirements<AuthType>>
  readonly authType: AuthType
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>
  readonly contextName: string
  // Explicit return type would have to re-express every derived hook
  // signature; `defineSliceLivestore` and `defineSliceHttpClient` take
  // the same inferred-return approach.
  // oxlint-disable-next-line typescript/explicit-function-return-type
}) => {
  const { layer, httpClientLayer, authType, contextName } = input

  type LayerInContext = typeof layer
  const ClientLayerContext = createContext<LayerInContext | null>(null)
  ClientLayerContext.displayName = `${contextName}ClientLayerContext`

  const providerName = `<${contextName}ClientProvider>`
  const hookName = `use${contextName}ClientLayer`

  const ClientProvider = ({ children }: PropsWithChildren): JSX.Element => (
    <ClientLayerContext.Provider value={layer}>{children}</ClientLayerContext.Provider>
  )
  ClientProvider.displayName = `${contextName}ClientProvider`

  // Pick the hook implementation at *factory* time, not per render.
  // React's rules of hooks require a fixed sequence of hook calls per
  // render — selecting on `authType` here means the bearer branch
  // unconditionally calls `useAuthTokenSubscribable` on every render
  // (so the hook order is stable), while the public branch never
  // references it at all. The runtime cost is a single comparison at
  // factory call time.
  //
  // The single cast on `useClientLayer` is the only one this file
  // needs: TS can't see that the bearer branch returns a layer typed
  // `Layer<Self | HttpClient | BearerToken, never, never>` (matching
  // `FullyProvidedSliceLayer<Self, 'bearer'>`) and the public branch
  // returns a layer typed `Layer<Self | HttpClient, never, never>`
  // (matching `FullyProvidedSliceLayer<Self, 'none'>`) — the
  // conditional type doesn't narrow on a runtime `authType` check —
  // so the assignment lifts both into the conditional return shape.
  const useBearerClientLayer = (): Layer.Layer<
    Self | HttpClient.HttpClient | BearerToken,
    never,
    never
  > => {
    const ctxLayer = useContext(ClientLayerContext) as Layer.Layer<
      Self,
      never,
      HttpClient.HttpClient | BearerToken
    > | null
    if (ctxLayer === null) {
      throw new Error(`${hookName} must be used inside ${providerName}`)
    }
    const tokenSubscribable = useAuthTokenSubscribable()
    return useMemo(
      () =>
        ctxLayer.pipe(
          Layer.provideMerge(Layer.succeed(BearerToken, tokenSubscribable)),
          Layer.provideMerge(httpClientLayer)
        ),
      [ctxLayer, tokenSubscribable]
    )
  }
  const usePublicClientLayer = (): Layer.Layer<Self | HttpClient.HttpClient, never, never> => {
    // The `as` narrows the conditional `SliceClientLayerRequirements<AuthType>`
    // down to the concrete public-mode requirements channel
    // (`HttpClient.HttpClient` only). Inside this branch the factory
    // selected `authType === 'none'`, so the narrowing is sound at
    // runtime even though TS can't see it through the type parameter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const ctxLayer = useContext(ClientLayerContext) as Layer.Layer<
      Self,
      never,
      HttpClient.HttpClient
    > | null
    if (ctxLayer === null) {
      throw new Error(`${hookName} must be used inside ${providerName}`)
    }
    return useMemo(() => ctxLayer.pipe(Layer.provideMerge(httpClientLayer)), [ctxLayer])
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const useClientLayer = (
    authType === 'bearer' ? useBearerClientLayer : usePublicClientLayer
  ) as () => FullyProvidedSliceLayer<Self, AuthType>

  const useEffectTs = <A, E>(effect: Effect.Effect<A, E, Self | Scope.Scope>): Promise<A> =>
    useKitchenSinkEffectTs(effect, useClientLayer())

  const useEffectAction = (): EffectAction<Self> => useKitchenSinkEffectAction(useClientLayer())

  const useStream = <A, E>(stream: Stream.Stream<A, E, Self | Scope.Scope>): Promise<A> =>
    useKitchenSinkStream(stream, useClientLayer())

  return {
    ClientLayerContext,
    ClientProvider,
    useClientLayer,
    useEffectTs,
    useEffectAction,
    useStream,
  } as const
}

export { defineSliceReact }
export type { FullyProvidedSliceLayer, SliceClientLayerRequirements }

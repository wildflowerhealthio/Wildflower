// `defineSliceReact` is a factory that *returns* a React component +
// hooks; the file exports a function, not a component. The
// fast-refresh rule's "only export components" check fires on the
// inner `ClientProvider` declaration anyway, so disable it at the
// file level rather than reshuffling the helper to dodge the false
// positive.
/* oxlint-disable react/only-export-components */
import { type HttpClient } from '@effect/platform'
import { type Context, type Effect, Layer, type Scope, type Stream } from 'effect'
import { type BearerToken } from 'kitchen-sink/auth-token'
import { createContext, type JSX, type PropsWithChildren, useContext, useMemo } from 'react'
import {
  bearerTokenLayer,
  type EffectAction,
  useAuthTokenSubscribable,
  useEffectAction,
  useEffectTs,
  useStream as useKitchenSinkStream,
} from 'react-kitchen-sink'
import type { SliceHttpClientAuth } from 'shared-structures-core/http-api-definition'
import { webHttpClientLayer } from 'telemetry-react'

/**
 * Layer requirements the slice's client layer leaves unprovided,
 * paralleling `shared-structures-core/http-api-definition`'s
 * `LayerRequirementsFor`. Re-declared so this package doesn't need to
 * re-export the type from the core helper.
 */
type SliceClientLayerRequirements<Auth extends SliceHttpClientAuth> = Auth extends 'bearer'
  ? HttpClient.HttpClient | BearerToken
  : HttpClient.HttpClient

/**
 * Result of fully providing the slice's client layer. App-level code
 * (e.g. `useAllClientsLayer`) consumes this shape directly.
 *
 * Both auth modes surface `BearerToken` in the result's success
 * channel: the helper unconditionally pipes `bearerTokenLayer` so
 * `useClientLayer` has the same hook signature for every slice. The
 * underlying public layer doesn't *require* `BearerToken`, so the
 * extra service is harmless — it's added to the provided set without
 * being read.
 */
type FullyProvidedSliceLayer<Self> = Layer.Layer<
  Self | HttpClient.HttpClient | BearerToken,
  never,
  never
>

/**
 * Bundle the React surface for a slice's HTTP client into one
 * declaration. Pair with `defineSliceHttpClient` from
 * `shared-structures-core/http-api-definition`: the slice's client tag
 * + layer + auth flag flow into this helper, which returns a context,
 * a provider, and the four hooks every slice-react package was
 * hand-rolling.
 *
 *  - `ClientLayerContext`: a `Context<Layer | null>` whose value is the
 *    slice's unprovided client layer. App-level code reads it via
 *    `useClientLayer` and composes with other slices in
 *    `useAllClientsLayer`.
 *  - `ClientProvider`: a tiny React provider that hands the layer to
 *    `ClientLayerContext`. Singleton — built once at factory time and
 *    reused across every mount.
 *  - `useClientLayer`: returns the slice layer with `webHttpClientLayer`
 *    and `bearerTokenLayer(useAuthTokenSubscribable())` merged in.
 *    Always provides the bearer layer; for `auth: 'none'` slices the
 *    extra service is unused, and the unified shape lets app-level
 *    composition treat every slice's hook the same way. Throws when
 *    used outside `<ClientProvider>`.
 *  - `useEffect` / `useEffectRunner` / `useStream`: thin wrappers around
 *    the kitchen-sink hooks, auto-providing the slice layer so screens
 *    can construct an Effect/Stream against the tag and run it.
 *
 * @example
 * ```tsx
 * const {
 *   ClientLayerContext: TunnelAdminClientLayerContext,
 *   ClientProvider: TunnelClientProvider,
 *   useClientLayer: useTunnelAdminClientLayer,
 *   useEffect: useTunnelAdminEffect,
 *   useEffectRunner: useTunnelAdminEffectRunner,
 *   useStream: useTunnelAdminStream,
 * } = defineSliceReact({
 *   ClientTag: TunnelAdminHttpApiClient,
 *   layer: TunnelAdminHttpApiClient.layer,
 *   auth: TunnelAdminHttpApiClient.auth,
 *   contextName: 'Tunnel',
 * })
 * ```
 */
const defineSliceReact = <Self, Shape, Auth extends SliceHttpClientAuth>(input: {
  readonly ClientTag: Context.Tag<Self, Shape>
  readonly layer: Layer.Layer<Self, never, SliceClientLayerRequirements<Auth>>
  // The `auth` field is recorded but not branched on at runtime — the
  // hook always merges both `bearerTokenLayer` and `webHttpClientLayer`,
  // and the underlying slice layer either uses `BearerToken` or
  // ignores it. The field stays in the API so the helper can grow a
  // narrower hook signature later (e.g. omitting `BearerToken` from
  // public clients' return type) without changing call sites.
  readonly auth: Auth
  readonly contextName: string
  // Explicit return type would have to re-express every derived hook
  // signature; `defineSliceLivestore` and `defineSliceHttpClient` take
  // the same inferred-return approach.
  // oxlint-disable-next-line typescript/explicit-function-return-type
}) => {
  const { layer, contextName } = input

  type LayerInContext = typeof layer
  const ClientLayerContext = createContext<LayerInContext | null>(null)
  ClientLayerContext.displayName = `${contextName}ClientLayerContext`

  const providerName = `<${contextName}ClientProvider>`
  const hookName = `use${contextName}ClientLayer`

  const ClientProvider = ({ children }: PropsWithChildren): JSX.Element => (
    <ClientLayerContext.Provider value={layer}>{children}</ClientLayerContext.Provider>
  )

  const useClientLayer = (): FullyProvidedSliceLayer<Self> => {
    const ctxLayer = useContext(ClientLayerContext)
    if (ctxLayer === null) {
      throw new Error(`${hookName} must be used inside ${providerName}`)
    }
    const tokenSubscribable = useAuthTokenSubscribable()
    return useMemo(() => {
      // The slice layer may or may not require `BearerToken` (depends
      // on `Auth`). `provideMerge` satisfies it when required and
      // otherwise adds it harmlessly to the success channel — the
      // underlying layer ignores the unused service. The runtime
      // `pipe` returns a layer whose requirements channel is
      // unconditionally `Self | HttpClient | BearerToken`, but TS
      // can't see through the `Auth`-conditional input type to that
      // uniform result, so a single cast bridges the public-mode
      // input back to the unified output shape.
      const provided = ctxLayer.pipe(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        Layer.provideMerge(bearerTokenLayer(tokenSubscribable)) as never,
        Layer.provideMerge(webHttpClientLayer)
      )
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return provided as FullyProvidedSliceLayer<Self>
    }, [ctxLayer, tokenSubscribable])
  }

  const useEffect = <A, E>(effect: Effect.Effect<A, E, Self | Scope.Scope>): Promise<A> =>
    useEffectTs(effect, useClientLayer())

  const useEffectRunner = (): EffectAction<Self> => useEffectAction(useClientLayer())

  const useStream = <A, E>(stream: Stream.Stream<A, E, Self | Scope.Scope>): Promise<A> =>
    useKitchenSinkStream(stream, useClientLayer())

  return {
    ClientLayerContext,
    ClientProvider,
    useClientLayer,
    useEffect,
    useEffectRunner,
    useStream,
  } as const
}

export { defineSliceReact }
export type { FullyProvidedSliceLayer, SliceClientLayerRequirements }

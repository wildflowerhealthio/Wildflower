import { type QueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { type Effect, type Layer } from 'effect'
import { type FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildFhirR4ResourcesClientLayer } from './client/fhir-r4-resources-client.ts'

type RuntimeLayer = Layer.Layer<
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer> | FhirR4ResourcesHttpApiClient,
  never,
  never
>

/**
 * Slice-local router-context shape — structurally a subset of the host
 * app's, but declared here so the slice doesn't import from the app.
 */
type RunAuthed = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<RuntimeLayer>>
) => Promise<A>

interface RouterContext {
  readonly queryClient: QueryClient
  readonly runAuthed: RunAuthed
  readonly runtimeLayer: RuntimeLayer
  /**
   * Whether the bearer token is ready — the single readiness reader the
   * app wires onto {@link BaseRouterContext.RouterContext}. The FHIR
   * slice has no routes/loaders of its own (its consumers live in other
   * slices), so this field is here only to keep the structural context
   * a faithful subset of the app's `RouterContext`.
   */
  readonly isTokenReady: () => boolean
}

/**
 * The FHIR R4 resources slice's client layer, ready for the app to merge
 * into its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`BearerToken | HttpClient`). Bearer-attaching per request — see
 * {@link buildFhirR4ResourcesClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  FhirR4ResourcesHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildFhirR4ResourcesClientLayer()

/**
 * The fully-composed `runtimeLayer` from router context, for the FHIR
 * call site that isn't a one-shot Promise and so can't go through
 * `runAuthed`/`useSuspenseQuery`:
 *
 *   - `collector-react`'s `useSyncRunner` — PUTs each parsed resource to
 *     `FhirR4ResourcesHttpApiClient` per bridge message, retried per
 *     resource. It is an imperative, event-driven runner (mirrors
 *     gatekeeper's `NeedsAuthMessage` device-flow fiber), NOT a one-shot
 *     query, so it `Effect.provide`s this layer and runs it itself.
 *
 * The annotated `select` re-narrows the result when the slice's router
 * isn't registered (standalone build / a host slice's router), where
 * `useRouteContext()` would otherwise widen to `any` — no cast.
 */
const useFhirR4ResourcesRuntimeLayer = (): RuntimeLayer =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runtimeLayer })

export { sliceRuntimeLayer, useFhirR4ResourcesRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }

import { useRouteContext } from '@tanstack/react-router'
import { type Layer } from 'effect'
import { type FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildFhirR4ResourcesClientLayer } from './client/fhir-r4-resources-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<FhirR4ResourcesHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<FhirR4ResourcesHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client. The FHIR slice has no
 * routes/loaders of its own (its consumers live in other slices), so
 * `awaitAuthReady` is inherited only to keep this structural context a
 * faithful subset of the host app's `RouterContext`.
 */
type RouterContext = BaseRouterContext.RouterContextWith<FhirR4ResourcesHttpApiClient>

/**
 * The FHIR R4 resources slice's client layer, ready for the app to merge
 * into its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`HttpClient`). Tokenless — see {@link buildFhirR4ResourcesClientLayer}.
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

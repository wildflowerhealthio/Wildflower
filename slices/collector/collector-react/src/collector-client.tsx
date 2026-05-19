// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate, generated via `defineSliceReact` from
 * `shared-structures-react`. Exposes the `CollectorClientLayerContext`
 * / `CollectorClientProvider` / `useCollectorClientLayer` /
 * `useCollectorEffect` / `useCollectorEffectRunner` /
 * `useCollectorStream` surface that screens and the app shell
 * consume.
 */
import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Effect, Scope } from 'effect'
import { defineSliceReact } from 'shared-structures-react'

const {
  ClientLayerContext: CollectorClientLayerContext,
  ClientProvider: CollectorClientProvider,
  useClientLayer: useCollectorClientLayer,
  useEffect: useCollectorEffect,
  useEffectRunner: useCollectorEffectRunner,
  useStream: useCollectorStream,
} = defineSliceReact({
  ClientTag: CollectorHttpApiClient,
  layer: CollectorHttpApiClient.layer,
  auth: CollectorHttpApiClient.auth,
  contextName: 'Collector',
})

/**
 * Type returned by {@link useCollectorEffectRunner}: an imperative
 * Effect runner pre-bound to the slice's client layer.
 */
type CollectorEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, CollectorHttpApiClient | Scope.Scope>
) => Promise<A>

export {
  CollectorClientLayerContext,
  CollectorClientProvider,
  useCollectorClientLayer,
  useCollectorEffect,
  useCollectorEffectRunner,
  useCollectorStream,
}
export type { CollectorEffectRunner }

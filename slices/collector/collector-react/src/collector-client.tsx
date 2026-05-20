// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate, generated via `defineSliceReact` from
 * `shared-structures-react`. Exposes the `CollectorClientLayerContext`
 * / `CollectorClientProvider` / `useCollectorClientLayer` /
 * `useCollectorEffect` / `useCollectorEffectAction` /
 * `useCollectorStream` surface that screens and the app shell
 * consume.
 */
import { CollectorHttpApiClient } from 'collector-core/clients'
import { defineSliceReact } from 'shared-structures-react'

const collectorSlice = defineSliceReact({
  ClientTag: CollectorHttpApiClient,
  layer: CollectorHttpApiClient.layer,
  authType: CollectorHttpApiClient.authType,
  contextName: 'Collector',
})

const {
  ClientLayerContext: CollectorClientLayerContext,
  ClientProvider: CollectorClientProvider,
  useClientLayer: useCollectorClientLayer,
  useEffectTs: useCollectorEffect,
  useEffectAction: useCollectorEffectAction,
  useStream: useCollectorStream,
} = collectorSlice

/**
 * Type returned by {@link useCollectorEffectAction}: an imperative
 * Effect runner pre-bound to the slice's client layer.
 */
type CollectorEffectAction = ReturnType<typeof collectorSlice.useEffectAction>

export {
  CollectorClientLayerContext,
  CollectorClientProvider,
  useCollectorClientLayer,
  useCollectorEffect,
  useCollectorEffectAction,
  useCollectorStream,
}
export type { CollectorEffectAction }

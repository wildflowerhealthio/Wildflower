// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate, generated via `defineSliceReact` from
 * `shared-structures-react`. Exposes the `GatekeeperClientLayerContext`
 * / `GatekeeperClientProvider` / `useGatekeeperClientLayer` /
 * `useGatekeeperEffect` / `useGatekeeperEffectAction` /
 * `useGatekeeperStream` surface that screens and the app shell
 * consume.
 */
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { defineSliceReact } from 'shared-structures-react'

const gatekeeperSlice = defineSliceReact({
  ClientTag: GatekeeperHttpApiClient,
  layer: GatekeeperHttpApiClient.layer,
  authType: GatekeeperHttpApiClient.authType,
  contextName: 'Gatekeeper',
})

const {
  ClientLayerContext: GatekeeperClientLayerContext,
  ClientProvider: GatekeeperClientProvider,
  useClientLayer: useGatekeeperClientLayer,
  useEffectTs: useGatekeeperEffect,
  useEffectAction: useGatekeeperEffectAction,
  useStream: useGatekeeperStream,
} = gatekeeperSlice

/**
 * Type returned by {@link useGatekeeperEffectAction}: an imperative
 * Effect runner pre-bound to the slice's client layer.
 */
type GatekeeperEffectAction = ReturnType<typeof gatekeeperSlice.useEffectAction>

export {
  GatekeeperClientLayerContext,
  GatekeeperClientProvider,
  useGatekeeperClientLayer,
  useGatekeeperEffect,
  useGatekeeperEffectAction,
  useGatekeeperStream,
}
export type { GatekeeperEffectAction }

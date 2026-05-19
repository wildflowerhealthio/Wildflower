// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate, generated via `defineSliceReact` from
 * `shared-structures-react`. Exposes the `GatekeeperClientLayerContext`
 * / `GatekeeperClientProvider` / `useGatekeeperClientLayer` /
 * `useGatekeeperEffect` / `useGatekeeperEffectRunner` /
 * `useGatekeeperStream` surface that screens and the app shell
 * consume.
 */
import type { Effect, Scope } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { defineSliceReact } from 'shared-structures-react'

const {
  ClientLayerContext: GatekeeperClientLayerContext,
  ClientProvider: GatekeeperClientProvider,
  useClientLayer: useGatekeeperClientLayer,
  useEffect: useGatekeeperEffect,
  useEffectRunner: useGatekeeperEffectRunner,
  useStream: useGatekeeperStream,
} = defineSliceReact({
  ClientTag: GatekeeperHttpApiClient,
  layer: GatekeeperHttpApiClient.layer,
  auth: GatekeeperHttpApiClient.auth,
  contextName: 'Gatekeeper',
})

/**
 * Type returned by {@link useGatekeeperEffectRunner}: an imperative
 * Effect runner pre-bound to the slice's client layer.
 */
type GatekeeperEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, GatekeeperHttpApiClient | Scope.Scope>
) => Promise<A>

export {
  GatekeeperClientLayerContext,
  GatekeeperClientProvider,
  useGatekeeperClientLayer,
  useGatekeeperEffect,
  useGatekeeperEffectRunner,
  useGatekeeperStream,
}
export type { GatekeeperEffectRunner }

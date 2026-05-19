// `defineSliceReact` returns a `ClientProvider` component alongside
// the hooks; the lint rule fires on the destructured re-export
// because it can't tell the component is meant to be consumed via
// this single barrel. Disable at the file level.
/* oxlint-disable react/only-export-components */
/**
 * Slice-react boilerplate for the apps slice — *two* clients (public
 * `AppsHttpApiClient` and admin `AppsAdminHttpApiClient`) bundled into
 * one combined `AppsClientProvider` so the app shell mounts a single
 * provider.
 */
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Effect, Scope } from 'effect'
import type { JSX, PropsWithChildren } from 'react'
import { defineSliceReact } from 'shared-structures-react'

const publicSlice = defineSliceReact({
  ClientTag: AppsHttpApiClient,
  layer: AppsHttpApiClient.layer,
  auth: AppsHttpApiClient.auth,
  contextName: 'Apps',
})

const adminSlice = defineSliceReact({
  ClientTag: AppsAdminHttpApiClient,
  layer: AppsAdminHttpApiClient.layer,
  auth: AppsAdminHttpApiClient.auth,
  contextName: 'AppsAdmin',
})

const {
  ClientLayerContext: AppsClientLayerContext,
  useClientLayer: useAppsClientLayer,
  useEffect: useAppsEffect,
  useEffectRunner: useAppsEffectRunner,
} = publicSlice

const {
  ClientLayerContext: AppsAdminClientLayerContext,
  useClientLayer: useAppsAdminClientLayer,
  useEffect: useAppsAdminEffect,
  useEffectRunner: useAppsAdminEffectRunner,
} = adminSlice

type AppsClientProviderProps = PropsWithChildren

/**
 * Provides both apps client `Layer`s to descendants — the public layer
 * (`AppsApi`, tokenless) via {@link AppsClientLayerContext}, and the
 * admin layer (`AppsAdminApi`, bearer-attaching) via
 * {@link AppsAdminClientLayerContext}. The admin layer reads the live
 * token from `BearerToken` (a Subscribable provided higher in the tree
 * via `<AuthTokenProvider>` from react-kitchen-sink).
 */
const AppsClientProvider = ({ children }: AppsClientProviderProps): JSX.Element => (
  <publicSlice.ClientProvider>
    <adminSlice.ClientProvider>{children}</adminSlice.ClientProvider>
  </publicSlice.ClientProvider>
)

/**
 * Type returned by {@link useAppsEffectRunner}: a public-client
 * imperative Effect runner pre-bound to the slice layer.
 */
type AppsEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, AppsHttpApiClient | Scope.Scope>
) => Promise<A>

/**
 * Type returned by {@link useAppsAdminEffectRunner}: an admin-client
 * imperative Effect runner pre-bound to the slice layer.
 */
type AppsAdminEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, AppsAdminHttpApiClient | Scope.Scope>
) => Promise<A>

export {
  AppsAdminClientLayerContext,
  AppsClientLayerContext,
  AppsClientProvider,
  useAppsAdminClientLayer,
  useAppsAdminEffect,
  useAppsAdminEffectRunner,
  useAppsClientLayer,
  useAppsEffect,
  useAppsEffectRunner,
}
export type { AppsAdminEffectRunner, AppsClientProviderProps, AppsEffectRunner }

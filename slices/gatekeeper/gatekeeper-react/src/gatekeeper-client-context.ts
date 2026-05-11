import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { createContext } from 'react'

/**
 * The value shared via context is the slice's client layer —
 * unprovided `HttpClient` and all. Apps compose this with other
 * slices' client layers in `useAllClientsLayer()` and provide a
 * single shared `HttpClient` once.
 *
 * Screens consume via `useGatekeeperClientLayer()` and write effects
 * that pipe through `Effect.provide(layer)`.
 */
const GatekeeperClientLayerContext = createContext<Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  HttpClient.HttpClient
> | null>(null)

export { GatekeeperClientLayerContext }

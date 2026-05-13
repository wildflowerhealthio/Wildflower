import type { HttpClient } from '@effect/platform'
import type { AppsHttpApiClient } from 'apps-core/clients'
import type { Layer } from 'effect'
import { createContext } from 'react'
import type { BearerToken } from 'react-kitchen-sink'

/**
 * The value shared via context is the slice's client layer —
 * unprovided `HttpClient` and `BearerToken` and all. Apps compose this
 * with other slices' client layers in `useAllClientsLayer()` and
 * provide `HttpClient` + `BearerToken` once.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useAppsEffect` / `useAppsEffectRunner`, which auto-provide
 * everything. The layer is exposed primarily so apps can compose it.
 */
const AppsClientLayerContext = createContext<Layer.Layer<
  AppsHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { AppsClientLayerContext }

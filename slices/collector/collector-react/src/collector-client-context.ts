import type { HttpClient } from '@effect/platform'
import type { CollectorHttpApiClient } from 'collector-core/clients'
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
 * `useCollectorEffect` / `useCollectorStream` / `useCollectorEffectRunner`,
 * which auto-provide everything. The layer is exposed primarily so
 * apps can compose it.
 */
const CollectorClientLayerContext = createContext<Layer.Layer<
  CollectorHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { CollectorClientLayerContext }

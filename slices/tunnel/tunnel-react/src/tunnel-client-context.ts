import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import type { BearerToken } from 'kitchen-sink/auth-token'
import { createContext } from 'react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

/**
 * The value shared via context is the slice's admin client layer —
 * `TunnelAdminApi` (`GetTunnel` + `PatchTunnel`). It reads `BearerToken`
 * at request time and attaches `Authorization: Bearer …`, leaving
 * `HttpClient` and `BearerToken` unprovided so apps share one of each
 * across every slice's client layer.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useTunnelAdminEffect` / `useTunnelAdminEffectRunner`, which
 * auto-provide everything. The layer is exposed primarily so apps can
 * compose it inside their `useAllClientsLayer()`.
 */
const TunnelAdminClientLayerContext = createContext<Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { TunnelAdminClientLayerContext }

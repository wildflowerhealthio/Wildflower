import type { HttpClient } from '@effect/platform'
import type { Layer } from 'effect'
import { createContext } from 'react'
import type { BearerToken } from 'react-kitchen-sink'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

/**
 * The value shared via context is the slice's *admin* client layer —
 * `TunnelAdminApi` (`GetTunnel` + `PatchTunnel`). Reads `BearerToken` at
 * request time and attaches `Authorization: Bearer …`, so the layer
 * needs `HttpClient` and `BearerToken` unprovided.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useTunnelAdminEffect` / `useTunnelAdminEffectRunner`, which
 * auto-provide everything. The layer is exposed primarily so apps can
 * compose it.
 */
const TunnelAdminClientLayerContext = createContext<Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { TunnelAdminClientLayerContext }

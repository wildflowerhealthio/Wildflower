import type { HttpClient } from '@effect/platform'
import type { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Layer } from 'effect'
import { createContext } from 'react'
import type { BearerToken } from 'react-kitchen-sink'

/**
 * The value shared via context is the slice's *public* client layer —
 * `AppsApi` (`ListApps` + `LaunchApp`), tokenless. Leaves `HttpClient`
 * unprovided so apps share one across every slice's client layer.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useAppsEffect` / `useAppsEffectRunner`, which auto-provide
 * everything. The layer is exposed primarily so apps can compose it.
 */
const AppsClientLayerContext = createContext<Layer.Layer<
  AppsHttpApiClient,
  never,
  HttpClient.HttpClient
> | null>(null)

/**
 * The value shared via context is the slice's *admin* client layer —
 * `AppsAdminApi` (custom-app writes + tunnel config). Reads
 * `BearerToken` at request time and attaches `Authorization: Bearer …`,
 * so the layer needs `HttpClient` and `BearerToken` unprovided.
 *
 * Slice screens shouldn't read the layer directly — use
 * `useAppsAdminEffect` / `useAppsAdminEffectRunner`, which auto-provide
 * everything. The layer is exposed primarily so apps can compose it.
 */
const AppsAdminClientLayerContext = createContext<Layer.Layer<
  AppsAdminHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> | null>(null)

export { AppsAdminClientLayerContext, AppsClientLayerContext }

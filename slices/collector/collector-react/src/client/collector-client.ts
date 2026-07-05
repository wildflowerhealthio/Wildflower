import type { HttpClient } from '@effect/platform'
import { CollectorHttpApiClient } from 'collector-core/clients'
import type { Layer } from 'effect'

/**
 * Union of services a `CollectorHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type CollectorClientRequirements = HttpClient.HttpClient | CollectorHttpApiClient

/**
 * Build a tokenless `CollectorHttpApiClient` layer.
 *
 * `CollectorHttpApiClient.layer` is produced by `defineSliceHttpClient`,
 * which sets no `Authorization` header — auth rides the `HttpOnly`
 * `wf_auth` cookie the browser sends with same-origin requests. This
 * builder just re-exposes that layer under a `buildXClientLayer()` name
 * matching the other slices (e.g. `gatekeeper-react`'s
 * `buildGatekeeperClientLayer`).
 *
 * Leaves `HttpClient` unprovided: the host app supplies one
 * (its `webHttpClientLayer`) shared across every slice's client layer
 * via the composed `runtimeLayer`.
 */
const buildCollectorClientLayer = (): Layer.Layer<
  CollectorHttpApiClient,
  never,
  HttpClient.HttpClient
> => CollectorHttpApiClient.layer

export { buildCollectorClientLayer, type CollectorClientRequirements }

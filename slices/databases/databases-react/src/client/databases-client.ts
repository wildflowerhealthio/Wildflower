import type { HttpClient } from '@effect/platform'
import { DatabasesHttpApiClient } from 'databases-core/clients'
import type { Layer } from 'effect'

/**
 * Union of services a `DatabasesHttpApiClient` consumer needs in context. The
 * slice's layer leaves `HttpClient` unprovided so apps share one across every
 * slice's client layer.
 */
type DatabasesClientRequirements = HttpClient.HttpClient | DatabasesHttpApiClient

/**
 * Build a tokenless `DatabasesHttpApiClient` layer.
 *
 * `DatabasesHttpApiClient.layer` is produced by `defineSliceHttpClient`, which
 * sets no `Authorization` header — auth rides the `HttpOnly` `wf_auth` cookie
 * the browser sends with same-origin requests. This builder just re-exposes that
 * layer under a `buildXClientLayer()` name matching the other slices. Leaves
 * `HttpClient` unprovided: the host app supplies one shared across every slice's
 * client layer via the composed `runtimeLayer`. Mirrors `tunnel-react`.
 */
const buildDatabasesClientLayer = (): Layer.Layer<
  DatabasesHttpApiClient,
  never,
  HttpClient.HttpClient
> => DatabasesHttpApiClient.layer

export { buildDatabasesClientLayer, type DatabasesClientRequirements }

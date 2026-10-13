import type { HttpClient } from '@effect/platform'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import type { Layer } from 'effect'

/**
 * Union of services a `AuthorizationServerHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` unprovided so apps
 * share one across every slice's client layer.
 */
type AuthorizationServerClientRequirements =
  | HttpClient.HttpClient
  | AuthorizationServerHttpApiClient

/**
 * Build a tokenless `AuthorizationServerHttpApiClient` layer.
 *
 * `AuthorizationServerHttpApiClient.layer` is produced by `defineSliceHttpClient`,
 * which sets no `Authorization` header — the host app's `HttpClient`
 * layer decides how requests authenticate. This builder just re-exposes that layer under a `buildXClientLayer()` name
 * matching the other slices (e.g. `databases-react`'s
 * `buildDatabasesClientLayer`).
 *
 * Leaves `HttpClient` unprovided: the host app supplies one (the
 * launcher's API transport) shared across every slice's client layer via the
 * composed `runtimeLayer`.
 */
const buildAuthorizationServerClientLayer = (): Layer.Layer<
  AuthorizationServerHttpApiClient,
  never,
  HttpClient.HttpClient
> => AuthorizationServerHttpApiClient.layer

export { buildAuthorizationServerClientLayer, type AuthorizationServerClientRequirements }

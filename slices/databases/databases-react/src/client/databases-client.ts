import type { HttpClient } from '@effect/platform'
import { HttpApiClient } from '@effect/platform'
import { DatabasesHttpApiClient } from 'databases-core/clients'
import { DatabasesApi } from 'databases-core/http-api-definition'
import { Layer } from 'effect'

/**
 * Union of services a `DatabasesHttpApiClient` consumer needs in context. The
 * slice's layer leaves `HttpClient` unprovided so apps share one across every
 * slice's client layer.
 */
type DatabasesClientRequirements = HttpClient.HttpClient | DatabasesHttpApiClient

/**
 * Build a tokenless `DatabasesHttpApiClient` layer.
 *
 * The host serves `/databases` behind the gatekeeper Owner check; auth rides
 * the `HttpOnly` `wf_auth` cookie the browser sends with same-origin requests,
 * so the client sets no `Authorization` header. Mirrors
 * `tunnel-react/src/client/tunnel-client.ts`.
 */
const buildDatabasesClientLayer = (): Layer.Layer<
  DatabasesHttpApiClient,
  never,
  HttpClient.HttpClient
> => Layer.effect(DatabasesHttpApiClient, HttpApiClient.make(DatabasesApi))

export { buildDatabasesClientLayer, type DatabasesClientRequirements }

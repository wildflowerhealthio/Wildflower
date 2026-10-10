import type { HttpClient } from '@effect/platform'
import { RequestLogHttpApiClient } from '@wildflowerhealthio/request-log-core-js/clients'
import type { Layer } from 'effect'

/**
 * Union of services a `RequestLogHttpApiClient` consumer needs in context. The
 * slice's layer leaves `HttpClient` unprovided so apps share one across every
 * slice's client layer.
 */
type RequestLogClientRequirements = HttpClient.HttpClient | RequestLogHttpApiClient

/**
 * Build a tokenless `RequestLogHttpApiClient` layer.
 *
 * `RequestLogHttpApiClient.layer` is produced by `defineSliceHttpClient`, which
 * sets no `Authorization` header — the host app's `HttpClient` layer decides
 * how requests authenticate. This builder re-exposes that layer under a
 * `buildXClientLayer()` name matching the other slices. Leaves `HttpClient`
 * unprovided: the host app supplies one (the launcher's API transport) shared
 * across every slice's client layer via the composed `runtimeLayer`.
 */
const buildRequestLogClientLayer = (): Layer.Layer<
  RequestLogHttpApiClient,
  never,
  HttpClient.HttpClient
> => RequestLogHttpApiClient.layer

export { buildRequestLogClientLayer, type RequestLogClientRequirements }

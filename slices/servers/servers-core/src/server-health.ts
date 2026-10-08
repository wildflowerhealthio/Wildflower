import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { Effect, type ParseResult } from 'effect'

import * as HealthReport from './health-report.ts'

/** Decode a `/health` response's body as a `HealthReport`. */
const decodeReport = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HealthReport.Type, HttpClientError.ResponseError | ParseResult.ParseError> =>
  HttpClientResponse.schemaBodyJson(HealthReport.Schema)(response)

/**
 * Read the server `domain`'s `/health` at its public origin,
 * `https://<domain>/health`.
 *
 * @remarks
 * A report that passes or warns answers `200` and one that fails `503`, its
 * report in the body either way; any other status fails with a
 * `ResponseError` of reason `StatusCode`. `/health` needs no credentials and
 * the server's tunnel listener answers it with CORS allowing any origin, so
 * the base's webview reads it directly: an answer means the request went
 * from the webview through the relay and the tunnel to the server and back.
 */
const readServerHealth = (
  domain: string
): Effect.Effect<
  HealthReport.Type,
  HttpClientError.HttpClientError | ParseResult.ParseError,
  HttpClient.HttpClient
> =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(`https://${domain}/health`))
  ).pipe(
    Effect.flatMap(
      HttpClientResponse.matchStatus({
        200: decodeReport,
        503: decodeReport,
        orElse: (response) =>
          Effect.fail(
            new HttpClientError.ResponseError({
              request: response.request,
              response,
              reason: 'StatusCode',
              description: `/health answered ${String(response.status)}`,
            })
          ),
      })
    )
  )

export { readServerHealth }

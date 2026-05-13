import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { FhirResourcesApi } from 'fhir-r4/http-api-definition'
import { BearerToken } from 'react-kitchen-sink'

/**
 * Union of services a `FhirR4ResourcesHttpApiClient` consumer needs in
 * context. The slice's layer leaves `HttpClient` and `BearerToken`
 * unprovided so apps share one of each across every slice's client
 * layer.
 */
type FhirR4ResourcesClientRequirements =
  | HttpClient.HttpClient
  | FhirR4ResourcesHttpApiClient
  | BearerToken

/**
 * Build a `FhirR4ResourcesHttpApiClient` layer that reads the bearer
 * token from the {@link BearerToken} service on every request. The
 * `transformClient` closes over the Subscribable resolved at
 * layer-resolution time; `Subscribable.get` runs *per request*, so a
 * token rotation surfaces immediately — no layer rebuild, no client
 * rebuild. Mirrors `buildGatekeeperClientLayer` in `gatekeeper-react`.
 */
const buildFhirR4ResourcesClientLayer = (): Layer.Layer<
  FhirR4ResourcesHttpApiClient,
  never,
  HttpClient.HttpClient | BearerToken
> =>
  Layer.effect(
    FhirR4ResourcesHttpApiClient,
    Effect.gen(function* () {
      const tokenSubscribable = yield* BearerToken
      return yield* HttpApiClient.make(FhirResourcesApi, {
        baseUrl: '/',
        transformClient: (c) =>
          HttpClient.mapRequestEffect(c, (request) =>
            Effect.map(tokenSubscribable.get, (token) =>
              token === null
                ? request
                : HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
            )
          ),
      })
    })
  )

export { buildFhirR4ResourcesClientLayer, type FhirR4ResourcesClientRequirements }

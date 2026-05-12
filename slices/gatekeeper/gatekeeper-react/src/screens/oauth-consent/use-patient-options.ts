import { HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect } from 'effect'
import { FhirResourcesApi } from 'fhir-r4/http-api-definition'
import { useEffect, useState } from 'react'
import {
  BearerToken,
  bearerTokenLayer,
  useAuthToken,
  useAuthTokenSubscribable,
} from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import type { PatientOption } from './types.ts'

/**
 * Build an FHIR R4 client whose `transformClient` reads the current
 * bearer token from the `BearerToken` service on every request — same
 * pattern as `buildGatekeeperClientLayer`. Token rotation surfaces
 * automatically without rebuilding the client.
 */
const fetchPatientOptionsEffect: Effect.Effect<
  readonly PatientOption[],
  unknown,
  HttpClient.HttpClient | BearerToken
> = Effect.gen(function* () {
  const tokenSubscribable = yield* BearerToken
  const client = yield* HttpApiClient.make(FhirResourcesApi, {
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
  const bundle = yield* client.Patient.SearchByGet({ urlParams: {} })
  return (bundle.entry ?? []).flatMap((entry): PatientOption[] => {
    const resource = entry.resource
    if (
      resource === undefined ||
      resource === null ||
      resource.id === undefined ||
      resource.id === null
    ) {
      return []
    }
    const name = resource.name?.[0]
    const given = name?.given?.join(' ') ?? ''
    const family = name?.family ?? ''
    const joined = [given, family].filter((s) => s !== '').join(' ')
    let displayName = joined
    if (displayName === '') displayName = resource.id
    return [{ id: resource.id, displayName }]
  })
}).pipe(
  Effect.tapErrorCause((cause) => Effect.logError('gatekeeper-react: patient lookup failed', cause))
)

interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
}

/**
 * Fetches the patient list from the FHIR R4 service inline (the patient
 * endpoint is on a different API surface than `GatekeeperHttpApiClient`,
 * so we don't reach for `useGatekeeperEffect`). Wires the same
 * `BearerToken`-driven transformClient + `webHttpClientLayer` as the
 * slice's main client, so token rotation surfaces here too.
 *
 * Skips entirely when no token is present — the patient picker is only
 * meaningful for an authenticated owner consenting to a SMART app.
 */
const usePatientOptions = (enabled: boolean): PatientOptionsState => {
  const token = useAuthToken()
  const tokenSubscribable = useAuthTokenSubscribable()
  const [options, setOptions] = useState<readonly PatientOption[]>([])
  const [loading, setLoading] = useState(enabled && token !== null)

  useEffect(() => {
    if (!enabled || token === null) {
      setOptions([])
      setLoading(false)
      return () => undefined
    }
    setLoading(true)
    let cancelled = false
    const fiber = Effect.runFork(
      fetchPatientOptionsEffect.pipe(
        Effect.provide(bearerTokenLayer(tokenSubscribable)),
        Effect.provide(webHttpClientLayer)
      )
    )
    fiber.addObserver((exit) => {
      if (cancelled) return
      if (exit._tag === 'Success') {
        setOptions(exit.value)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token, tokenSubscribable, enabled])

  return { options, loading }
}

export { usePatientOptions }
export type { PatientOptionsState }

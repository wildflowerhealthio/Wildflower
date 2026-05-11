import { HttpApiClient, type HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { FhirResourcesApi } from 'fhir-r4/http-api-definition'
import { useEffect, useState } from 'react'
import { webHttpClientLayer } from 'telemetry-react'

import { makeBearerTokenClientTransformer } from '../../client/gatekeeper-client.ts'
import { useToken } from '../../client/use-token.ts'
import type { PatientOption } from './types.ts'

const fetchPatientOptionsEffect = (
  token: string
): Effect.Effect<readonly PatientOption[], unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(FhirResourcesApi, {
      baseUrl: '/',
      transformClient: makeBearerTokenClientTransformer(token),
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
    Effect.tapErrorCause((cause) =>
      Effect.logError('gatekeeper-react: patient lookup failed', cause)
    )
  )

interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
}

/**
 * Fetches the patient list from the FHIR R4 service inline (rather
 * than via `useGatekeeperClientLayer()` — the patient endpoint is on
 * a different API surface). Uses `useToken()` for the bearer header
 * and `webHttpClientLayer` for the HTTP transport, so a single auth
 * source still drives both surfaces.
 *
 * Skips entirely when `useToken()` returns `null` — the patient picker
 * is only meaningful for an authenticated owner consenting to a SMART
 * app.
 */
const usePatientOptions = (enabled: boolean): PatientOptionsState => {
  const token = useToken()
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
      fetchPatientOptionsEffect(token).pipe(Effect.provide(webHttpClientLayer))
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
  }, [token, enabled])

  return { options, loading }
}

export { usePatientOptions }
export type { PatientOptionsState }

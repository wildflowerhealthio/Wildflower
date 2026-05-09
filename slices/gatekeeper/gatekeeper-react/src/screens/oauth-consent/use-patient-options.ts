import { HttpApiClient, type HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import { FhirResourcesApi } from 'fhir-r4/http-api-definition'
import { useEffect, useState } from 'react'

import type { AuthenticatedSession } from '../../client.ts'
import { setBearerToken } from '../../client.ts'
import type { PatientOption } from './types.ts'

const fetchPatientOptionsEffect = (
  session: AuthenticatedSession
): Effect.Effect<readonly PatientOption[], unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(FhirResourcesApi, {
      baseUrl: '/',
      transformClient: setBearerToken(session.token),
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
 * Fetches the patient list from the FHIR R4 service. Failures log through
 * the session runtime's logger (Sentry + console via telemetry-web).
 */
const usePatientOptions = (
  session: AuthenticatedSession,
  enabled: boolean
): PatientOptionsState => {
  const [options, setOptions] = useState<readonly PatientOption[]>([])
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!enabled) {
      setOptions([])
      setLoading(false)
      return () => undefined
    }
    setLoading(true)
    let cancelled = false
    const fiber = Effect.runFork(
      fetchPatientOptionsEffect(session).pipe(Effect.provide(session.runtime))
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
  }, [session, enabled])

  return { options, loading }
}

export { usePatientOptions }
export type { PatientOptionsState }

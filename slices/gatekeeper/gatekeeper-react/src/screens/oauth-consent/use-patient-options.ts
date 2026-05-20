import { Cause, Effect } from 'effect'
import { useFhirR4ResourcesEffectAction } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { useEffect, useState } from 'react'

import type { PatientOption } from './types.ts'

interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
}

/**
 * Fetches the patient list from the FHIR R4 service. The patient
 * endpoint sits on a different API surface than `GatekeeperHttpApiClient`,
 * so we reach for `useFhirR4ResourcesEffectAction` — the slice's
 * pre-bound runner already wires `FhirR4ResourcesHttpApiClient.layer`
 * (bearer-attaching), the host's HttpClient layer, and BearerToken,
 * so this hook just builds the Effect and runs it.
 *
 * Skips entirely when not enabled — the patient picker is only
 * meaningful for an authenticated owner consenting to a SMART app.
 */
const usePatientOptions = (enabled: boolean): PatientOptionsState => {
  const runFhir = useFhirR4ResourcesEffectAction()
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
    const fetchOptions = Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
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
    })
    runFhir(fetchOptions)
      .then((loadedOptions) => {
        if (!cancelled) setOptions(loadedOptions)
      })
      .catch((cause: unknown) => {
        Effect.runFork(Effect.logError('gatekeeper-react: patient lookup failed', Cause.die(cause)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runFhir, enabled])

  return { options, loading }
}

export { usePatientOptions }
export type { PatientOptionsState }

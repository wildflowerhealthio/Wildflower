import { usePatientsQuery } from 'fhir-r4-react'

import type { PatientOption } from './patient-pill-picker.tsx'

interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
}

/**
 * Fetches the patient list from the FHIR R4 service and maps it to the
 * `{ id, displayName }` options the consent radio group renders.
 *
 * The patient endpoint sits on a different API surface than
 * `GatekeeperHttpApiClient`, so the read lives in `fhir-r4-react`'s
 * {@link usePatientsQuery} — a TanStack Query keyed off the slice's
 * `runAuthed` (post-migration; the old `useFhirR4ResourcesEffectAction`
 * runner is gone). This hook keeps only the gatekeeper-specific
 * presentation mapping (display-name derivation, the `PatientOption`
 * shape) and the `loading` flag the form needs.
 *
 * `enabled` gates the query off entirely when not needed — the picker is
 * only meaningful for an authenticated owner consenting to a SMART app
 * that requested a `patient/*` scope. While disabled the query never
 * fires (`isLoading` stays `false`, `data` `undefined`), so this returns
 * an empty list and `loading: false`.
 */
const usePatientOptions = (enabled: boolean): PatientOptionsState => {
  const query = usePatientsQuery(enabled)

  const options: readonly PatientOption[] = (query.data ?? []).flatMap(
    (resource): readonly PatientOption[] => {
      if (resource.id === undefined || resource.id === null) return []
      const name = resource.name?.[0]
      const given = name?.given?.join(' ') ?? ''
      const family = name?.family ?? ''
      const joined = [given, family].filter((s) => s !== '').join(' ')
      const displayName = joined === '' ? resource.id : joined
      return [{ id: resource.id, displayName }]
    }
  )

  return { options, loading: enabled && query.isLoading }
}

export { usePatientOptions }
export type { PatientOptionsState }

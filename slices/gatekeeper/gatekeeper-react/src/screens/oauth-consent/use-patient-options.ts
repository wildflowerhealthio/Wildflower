import { usePatientsQuery } from 'fhir-r4-react'
import { HumanName } from 'fhir-r4/data-types'
import type { PatientOption } from 'scopes-react'

interface PatientOptionsState {
  readonly options: readonly PatientOption[]
  readonly loading: boolean
  /** Why the patient list could not be read, or `null` when it was (or was not asked for). */
  readonly error: Error | null
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
 * presentation mapping (the `PatientOption` shape, and its display name:
 * `fhir-r4`'s {@link HumanName.displayName}, else the resource id) and the
 * `loading` flag the form needs.
 *
 * `enabled` gates the query off entirely when not needed — the picker is
 * only meaningful for an authenticated owner consenting to a SMART app
 * that requested a `patient/*` scope. While disabled the query never
 * fires (`isLoading` stays `false`, `data` `undefined`), so this returns
 * an empty list and `loading: false`.
 *
 * A failed read is returned as `error`, not folded into an empty list: the
 * form has to tell "this server has no patients" from "the patient list could
 * not be read".
 */
const usePatientOptions = (enabled: boolean): PatientOptionsState => {
  const query = usePatientsQuery(enabled)

  const options: readonly PatientOption[] = (query.data ?? []).flatMap(
    (resource): readonly PatientOption[] => {
      if (resource.id === undefined || resource.id === null) return []
      const displayName = HumanName.displayName(resource.name) ?? resource.id
      return [{ id: resource.id, displayName }]
    }
  )

  return { options, loading: enabled && query.isLoading, error: query.error }
}

export { usePatientOptions }
export type { PatientOptionsState }

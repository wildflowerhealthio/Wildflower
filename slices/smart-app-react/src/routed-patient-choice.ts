import type { QueryClient } from '@tanstack/react-query'
import { notFound, useParams } from '@tanstack/react-router'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Option, Schema } from 'effect'
import { useMemo } from 'react'

import type { PatientChoice } from './patient-choice.ts'
import { patientQuery } from './patient-query.ts'

/**
 * The path param a routed SMART app's patient routes name their patient
 * with: `/patients/$patientId` and every route under it.
 */
const PATIENT_ID_PARAM = 'patientId'

/**
 * The route a completed launch opens in a routed app: the launch's patient's
 * (`/patients/<id>`, e.g. an EHR launch from a patient's record), else the
 * patient picker (`/patients`). A `SmartHandshakeGate`'s `landsOn`.
 */
const launchPatientRoute = (client: SmartClient): string =>
  client.patient.id === null ? '/patients' : `/patients/${encodeURIComponent(client.patient.id)}`

/** `params`' {@link PATIENT_ID_PARAM} when the open route has one, else `undefined`. */
const patientIdParamOf = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const patientId = params[PATIENT_ID_PARAM]
  return typeof patientId === 'string' ? patientId : undefined
}

/**
 * Whose records the open route reads: the patient its path names (under
 * `/patients/$patientId`), else every patient's (an app's all-patients
 * routes).
 *
 * @remarks
 * Read under whichever route is matched (`strict: false`), so the hook needs
 * no app's route tree. A path param is the string the address bar holds, so
 * an id such as `1.50` reads as itself.
 */
const useRoutedPatientChoice = (): PatientChoice => {
  const patientId = useParams({ strict: false, select: patientIdParamOf })
  return useMemo(
    (): PatientChoice =>
      patientId === undefined ? { kind: 'all-patients' } : { kind: 'patient', patientId },
    [patientId]
  )
}

/** The `notFound()` data {@link ensureRoutedPatient} throws: the id no patient is under. */
const MissingPatient = Schema.Struct({ missingPatientId: Schema.String })

/**
 * The patient id a route's `notFoundComponent` was handed by
 * {@link ensureRoutedPatient} (its `data`), or `None` for a path no route
 * matched.
 */
const missingPatientIdOf = (notFoundData: unknown): Option.Option<string> =>
  Option.map(
    Schema.decodeUnknownOption(MissingPatient)(notFoundData),
    ({ missingPatientId }) => missingPatientId
  )

/**
 * A patient route's `loader`: read patient `patientId` into the page's cache
 * (`patientQuery`, the read `PatientChoiceLine` then names them from), and
 * throw TanStack's `notFound()` when the server holds no such patient (404
 * or 410), for the route's `notFoundComponent` (`PatientRouteNotFound`) to
 * say so.
 *
 * @remarks
 * Any other failure lets the route render: the patient line says the read
 * failed, since a server that could not answer is not one without the
 * patient.
 */
const ensureRoutedPatient = async (
  queryClient: QueryClient,
  client: SmartClient,
  patientId: string
): Promise<void> => {
  // A read already in the cache is used as it stands, as the patient line
  // would show it.
  const patientRead = await queryClient
    .query({ ...patientQuery(client, patientId), staleTime: 'static' })
    .catch(() => null)
  if (patientRead?.kind === 'missing') {
    throw notFound({ data: MissingPatient.make({ missingPatientId: patientId }) })
  }
}

export { ensureRoutedPatient, launchPatientRoute, missingPatientIdOf, useRoutedPatientChoice }

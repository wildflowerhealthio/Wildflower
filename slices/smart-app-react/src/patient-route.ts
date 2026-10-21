import type { QueryClient } from '@tanstack/react-query'
import { notFound, useParams } from '@tanstack/react-router'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Option } from 'effect'
import { useMemo } from 'react'

import type { PatientChoice } from './patient-choice.ts'
import { patientQuery } from './patient-query.ts'

/**
 * The path param a routed SMART app's patient routes name their patient
 * with: `/patients/$patientId` and every route under it.
 */
const PATIENT_ID_PARAM = 'patientId'

/**
 * The route a completed launch starts on in a routed app: the launch's
 * patient's (`/patients/<id>`, e.g. an EHR launch from a patient's record),
 * else the patient picker (`/patients`). What the app's `/` redirects to
 * when the launch saved no route of its own (`appRootRedirect`).
 */
const launchStartRoute = (client: SmartClient): string =>
  Option.match(client.launchPatientId, {
    onNone: () => '/patients',
    onSome: (patientId) => `/patients/${encodeURIComponent(patientId)}`,
  })

/** `params`' {@link PATIENT_ID_PARAM} when the open route has one, else `undefined`. */
const patientIdParamOf = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const patientId = params[PATIENT_ID_PARAM]
  return typeof patientId === 'string' ? patientId : undefined
}

/**
 * The patient the open route's path names (under `/patients/$patientId`),
 * or `undefined` on a route naming none.
 *
 * @remarks
 * Read under whichever route is matched (`strict: false`), so the hook needs
 * no app's route tree. A path param is the string the address bar holds, so
 * an id such as `1.50` reads as itself.
 */
const usePathPatientId = (): string | undefined =>
  useParams({ strict: false, select: patientIdParamOf })

/**
 * Whose records the open route reads: the patient its path names, else
 * every patient's (an app's all-patients routes).
 */
const usePathPatientChoice = (): PatientChoice => {
  const patientId = usePathPatientId()
  return useMemo(
    (): PatientChoice =>
      patientId === undefined ? { kind: 'all-patients' } : { kind: 'patient', patientId },
    [patientId]
  )
}

/**
 * A patient route's `loader`: read patient `patientId` into the page's cache
 * (`patientQuery`, the read `PatientChoiceLine` then names them from), and
 * throw TanStack's `notFound()` when the server holds no such patient (404
 * or 410), for the route's `notFoundComponent` (`NoPatientCard`) to say so.
 *
 * @remarks
 * Any other failure lets the route render: the patient line says the read
 * failed, since a server that could not answer is not one without the
 * patient.
 */
const requirePatient = async (
  queryClient: QueryClient,
  client: SmartClient,
  patientId: string
): Promise<void> => {
  // A read already in the cache is used as it stands, as the patient line
  // would show it.
  const missing = await queryClient
    .query({ ...patientQuery(client, patientId), staleTime: 'static' })
    .then(Option.isNone, () => false)
  if (missing) throw notFound()
}

export { launchStartRoute, requirePatient, usePathPatientChoice, usePathPatientId }

import { useInfiniteQuery } from '@tanstack/react-query'
import { Effect, Match } from 'effect'
import { fetchPatientPage, type PatientPageCursor } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { pagedQueryStatusOf } from 'react-kitchen-sink'
import { ItemList } from 'react-tundraish'
import { LoadingLine, LoadingMoreLine, ReadFailureLine } from 'smart-app-react'

import { birthLineOf, patientNameOf } from './patient-line.ts'
import type { SmartClient } from './smart-client.ts'
import styles from './app.module.css'

const FIRST_PATIENT_PAGE: PatientPageCursor = { first: null }

interface PatientPickerProps {
  /** The SMART client the patient search is issued through. */
  readonly client: SmartClient
  /** Called with the id of the patient the reader chose. */
  readonly onPatientPick: (patientId: string) => void
}

/**
 * The patients the session can see, for a launch with no patient in context:
 * one row per patient with their name and birth date, sorted by family name
 * server-side, and a button for the next page while the server has one.
 *
 * @remarks
 * A patient without an `id` has nothing to be chosen by, so it gets no row.
 * After a failed page the button stays, as the retry.
 */
const PatientPicker = ({ client, onPatientPick }: PatientPickerProps): JSX.Element => {
  const patients = useInfiniteQuery({
    queryKey: ['patient-picker'],
    queryFn: ({ pageParam }: { readonly pageParam: PatientPageCursor }) =>
      Effect.runPromise(fetchPatientPage(client, pageParam)),
    initialPageParam: FIRST_PATIENT_PAGE,
    getNextPageParam: (lastPage): PatientPageCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  const rows = (patients.data?.pages ?? []).flatMap((page) =>
    page.items.flatMap((patient) => {
      const patientId = patient.id ?? null
      if (patientId === null) return []
      return [
        {
          id: patientId,
          title: patientNameOf(patient),
          subtitle: birthLineOf(patient) ?? undefined,
          onClick: () => {
            onPatientPick(patientId)
          },
        },
      ]
    })
  )
  const morePatientsButton = (
    <button
      type="button"
      className={styles['more-patients']}
      onClick={() => {
        void patients.fetchNextPage()
      }}
    >
      More patients
    </button>
  )
  const patientList = (footer: JSX.Element | null): JSX.Element => (
    <section className={styles.picker}>
      <h2 className="text-heading-5">Choose a patient</h2>
      {rows.length === 0 ? (
        <p className={styles.status}>No patients on this server.</p>
      ) : (
        <ItemList items={rows} />
      )}
      {footer}
    </section>
  )

  return Match.value(pagedQueryStatusOf(patients)).pipe(
    Match.when({ kind: 'loading' }, () => <LoadingLine />),
    Match.when({ kind: 'failed' }, ({ error }) => (
      <ReadFailureLine subject="patients" error={error} />
    )),
    Match.when({ kind: 'paging', isFetchingNextPage: true }, () =>
      patientList(<LoadingMoreLine />)
    ),
    Match.when({ kind: 'paging' }, () => patientList(morePatientsButton)),
    Match.when({ kind: 'page-failed' }, ({ error }) =>
      patientList(
        <>
          <ReadFailureLine subject="patients" error={error} />
          {morePatientsButton}
        </>
      )
    ),
    Match.when({ kind: 'complete' }, () => patientList(null)),
    Match.exhaustive
  )
}

export { PatientPicker }

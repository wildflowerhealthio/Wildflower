import { useInfiniteQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { fetchPatientPage, type PatientPageCursor, type SmartHandshake } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { ItemList } from 'react-tundraish'

import { birthLineOf, patientNameOf } from './patient-line.ts'
import styles from './app.module.css'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

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

  if (patients.data === undefined) {
    return patients.isError ? (
      <p className={styles.error}>
        Could not load patients:{' '}
        {patients.error instanceof Error ? patients.error.message : String(patients.error)}
      </p>
    ) : (
      <p className={styles.status}>Loading…</p>
    )
  }

  const rows = patients.data.pages.flatMap((page) =>
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

  return (
    <section className={styles.picker}>
      <h2 className="text-heading-5">Choose a patient</h2>
      {rows.length === 0 ? (
        <p className={styles.status}>No patients on this server.</p>
      ) : (
        <ItemList items={rows} />
      )}
      {patients.isFetchingNextPage && <p className={styles.status}>Loading more…</p>}
      {patients.isFetchNextPageError && (
        <p className={styles.error}>
          Could not load patients:{' '}
          {patients.error instanceof Error ? patients.error.message : String(patients.error)}
        </p>
      )}
      {patients.hasNextPage && !patients.isFetchingNextPage && (
        <button
          type="button"
          className={styles['more-patients']}
          onClick={() => {
            void patients.fetchNextPage()
          }}
        >
          More patients
        </button>
      )}
    </section>
  )
}

export { PatientPicker, type SmartClient }

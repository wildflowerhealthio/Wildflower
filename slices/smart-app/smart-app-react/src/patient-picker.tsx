import { useInfiniteQuery } from '@tanstack/react-query'
import { Effect, Match } from 'effect'
import { fetchPatientPage, type PatientPageCursor } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { pagedQueryStatusOf } from 'react-kitchen-sink'
import { ItemList, type ItemListItem } from 'react-tundraish'

import { type PatientChoice, patientChoiceKeyOf } from './patient-choice.ts'
import { birthLineOf, patientNameOf } from './patient-line.ts'
import { LoadingLine, LoadingMoreLine, ReadFailureLine } from './read-status-lines.tsx'
import type { SmartClient } from './smart-client.ts'
import styles from './patient-picker.module.css'

const FIRST_PATIENT_PAGE: PatientPageCursor = { first: null }

/** Props for {@link PatientPicker}. */
interface PatientPickerProps {
  /** The SMART client the patient search is issued through. */
  readonly client: SmartClient
  /** Called with what the reader chose: one patient, or every patient. */
  readonly onPatientChoice: (patientChoice: PatientChoice) => void
}

/**
 * The patients the session can see, to choose whose records the app reads:
 * an "All patients" row first, then one row per patient with their name and
 * birth date, sorted by family name server-side, and a button for the next
 * page while the server has one.
 *
 * @remarks
 * A patient without an `id` has nothing to be chosen by, so it gets no row.
 * After a failed page the button stays, as the retry.
 */
const PatientPicker = ({ client, onPatientChoice }: PatientPickerProps): JSX.Element => {
  const patients = useInfiniteQuery({
    queryKey: ['patient-picker'],
    queryFn: ({ pageParam }: { readonly pageParam: PatientPageCursor }) =>
      Effect.runPromise(fetchPatientPage(client, pageParam)),
    initialPageParam: FIRST_PATIENT_PAGE,
    getNextPageParam: (lastPage): PatientPageCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  const allPatients: PatientChoice = { kind: 'all-patients' }
  const allPatientsRow: ItemListItem = {
    id: patientChoiceKeyOf(allPatients),
    title: 'All patients',
    subtitle: "Every patient's records together",
    onClick: () => {
      onPatientChoice(allPatients)
    },
  }
  const patientRows = (patients.data?.pages ?? []).flatMap((page) =>
    page.items.flatMap((patient): readonly ItemListItem[] => {
      const patientId = patient.id ?? null
      if (patientId === null) return []
      const onePatient: PatientChoice = { kind: 'patient', patientId }
      return [
        {
          id: patientChoiceKeyOf(onePatient),
          title: patientNameOf(patient),
          subtitle: birthLineOf(patient) ?? undefined,
          onClick: () => {
            onPatientChoice(onePatient)
          },
        },
      ]
    })
  )
  const morePatientsButton = (
    <button
      type="button"
      className={styles['patient-picker__more']}
      onClick={() => {
        void patients.fetchNextPage()
      }}
    >
      More patients
    </button>
  )
  const patientList = (footer: JSX.Element | null): JSX.Element => (
    <section className={styles['patient-picker']}>
      <h2 className="text-heading-5">Choose a patient</h2>
      <ItemList items={[allPatientsRow, ...patientRows]} />
      {patientRows.length === 0 && (
        <p className={styles['patient-picker__empty']}>No patients on this server.</p>
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

export { PatientPicker, type PatientPickerProps }

import { createRootRouteWithContext, retainSearchParams, useNavigate } from '@tanstack/react-router'
import { useFetchEveryPage } from '@wildflowerhealthio/react-kitchen-sink'
import { ChunkBar, RouteTabs } from '@wildflowerhealthio/react-tundraish'
import {
  LoadingLine,
  PATIENT_PARAM,
  PatientChoiceLine,
  type PatientChoice,
  patientChoiceKeyOf,
  PatientPicker,
  ReadFailureLine,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option, Schema } from 'effect'
import { type JSX, useState } from 'react'

import { type RouterContext, type SmartClient, useSmartClient } from '../router-context.ts'
import { useChosenPatient } from './-chosen-patient.ts'
import { type MedicationRead, useMedicationRead } from './-medication-read.ts'
import { MedicationsNotFound } from './-medications-not-found.tsx'
import styles from './-medications-page.module.css'

/** The chunk bar's copy: the generic component with this app's wording. */
const chunkBarLabels = {
  ariaIdle: (pages: number) => `${pages} pages of your medication list loaded so far`,
  ariaLoading: (pages: number) => `Loading your medication list — ${pages} pages in so far`,
  ariaLocked: 'Your full medication list is loaded',
  ariaError: (pages: number) =>
    `Loading paused after a failed page — ${pages} pages of your medication list in so far`,
  countSuffix: 'medication requests have been loaded.',
  lockedNote: 'That is all of them. Everything below is checked against the full list.',
  errorNote: 'A page of your medication list failed to load — the list is incomplete.',
  retry: 'Retry',
}

/** Props for {@link MedicationsPage}. */
interface MedicationsPageProps {
  readonly client: SmartClient
  /** Whose medications the page reads. */
  readonly patientChoice: PatientChoice
  /** Go back to the patient picker: the patient line's "Change patient". */
  readonly onPatientChange: () => void
}

/**
 * The medications page's logic: the chosen patient's read, and the driver
 * that reads every remaining page while the reader has asked for them. The
 * driver runs here, once for the page, so it keeps going as the reader
 * changes tabs.
 */
const useMedicationsPage = (): MedicationRead => {
  const read = useMedicationRead()
  useFetchEveryPage(read.pagedQuery, { enabled: read.everyPageRequested })
  return read
}

/**
 * The medications page: the patient line and the chunk bar tracking the
 * paged read, over the tabs, each a child route the strip links to:
 * Medications, the list; Calendar, the prescription calendar; Interactions,
 * the report over the current medications; Savings, the savings-program
 * breakdown. Until the first page lands the tabs wait behind a loading line,
 * or the read's failure.
 */
function MedicationsPage({
  client,
  patientChoice,
  onPatientChange,
}: MedicationsPageProps): JSX.Element {
  const read = useMedicationsPage()
  const { pagedQuery, pagesReceived } = read
  return (
    <>
      <div className={styles['medications-page__status']}>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={onPatientChange}
        />
        <ChunkBar
          phase={read.barPhase}
          pagesReceived={pagesReceived}
          loadedCount={read.views.length}
          onLoadAll={read.requestEveryPage}
          labels={chunkBarLabels}
        />
      </div>
      {Match.value({
        firstPageError: pagedQuery.isError && pagesReceived === 0 ? pagedQuery.error : undefined,
        hasPages: pagesReceived > 0,
      }).pipe(
        Match.when({ firstPageError: Match.defined }, ({ firstPageError }) => (
          <ReadFailureLine subject="medications" error={firstPageError} />
        )),
        Match.when({ hasPages: false }, () => <LoadingLine subject="medications" />),
        Match.orElse(() => (
          <RouteTabs
            tabs={[
              { to: '/medications', label: 'Medications' },
              { to: '/calendar', label: 'Calendar' },
              { to: '/interactions', label: 'Interactions' },
              { to: '/savings', label: 'Savings' },
            ]}
            aria-label="Medication views"
          />
        ))
      )}
    </>
  )
}

/** What the root shows: the page for a patient, or the picker. */
interface MedicationsRootModel {
  readonly client: SmartClient
  /** Whose medications the page shows; `None` while the picker is up. */
  readonly shownPatient: Option.Option<PatientChoice>
  /** Settle on `patientChoice`: the picker's `onPatientChoice`. */
  readonly choosePatient: (patientChoice: PatientChoice) => void
  /** Open the picker over the patient shown: the patient line's "Change patient". */
  readonly changePatient: () => void
}

/**
 * The root's logic: whose medications the address bar names, the picker
 * the reader opened over them, and choosing.
 *
 * @remarks
 * A choice navigates, pushing a history entry on the tab open, with
 * `?patient=` naming it: Back returns to the patient before (from the first
 * choice, to the picker), and a reload or a shared link opens the patient
 * the address bar names. "Change patient" only opens the picker, over the
 * patient it was opened from; the address bar keeps that patient until
 * another is chosen, and Back or Forward to an entry naming a different
 * patient closes the picker on that patient's page.
 */
const useMedicationsRoot = (): MedicationsRootModel => {
  const client = useSmartClient()
  const chosenPatient = useChosenPatient()
  const navigate = useNavigate()
  const chosenKey = Option.getOrNull(Option.map(chosenPatient, patientChoiceKeyOf))
  const [changingFrom, setChangingFrom] = useState<string | null>(null)
  // The address bar has moved to another patient (Back, Forward): the picker
  // closes for good, rather than reopening on a return to its entry.
  if (changingFrom !== null && changingFrom !== chosenKey) setChangingFrom(null)
  return {
    client,
    shownPatient: Option.filter(chosenPatient, () => changingFrom !== chosenKey),
    choosePatient: (patientChoice) => {
      setChangingFrom(null)
      void navigate({ to: '.', search: { [PATIENT_PARAM]: patientChoiceKeyOf(patientChoice) } })
    },
    changePatient: () => {
      setChangingFrom(chosenKey)
    },
  }
}

/**
 * The root route's page: the medications page for the patient chosen, or,
 * with none (or while the reader changes it), the patient picker.
 */
function MedicationsRoot(): JSX.Element {
  const { client, shownPatient, choosePatient, changePatient } = useMedicationsRoot()
  return Match.value({ patientChoice: Option.getOrUndefined(shownPatient) }).pipe(
    Match.when({ patientChoice: Match.defined }, ({ patientChoice }): JSX.Element => (
      <MedicationsPage
        client={client}
        patientChoice={patientChoice}
        onPatientChange={changePatient}
      />
    )),
    Match.orElse((): JSX.Element => (
      <PatientPicker client={client} onPatientChoice={choosePatient} />
    ))
  )
}

/**
 * The search every route carries: whose medications the page reads,
 * `?patient=` (a patient's id, or `*` for every patient), absent for the
 * launch's patient.
 */
const PatientSearch = Schema.Struct({ [PATIENT_PARAM]: Schema.optional(Schema.String) })

/**
 * The root route: the patient picker or the medications page, each of whose
 * tabs is a child route, and in the tab panel for a path no tab names, the
 * not-found card.
 *
 * @remarks
 * Every navigation keeps `?patient=`, so changing tabs keeps the patient and
 * each history entry names the patient it showed.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Schema.standardSchemaV1(PatientSearch),
  search: { middlewares: [retainSearchParams([PATIENT_PARAM])] },
  component: MedicationsRoot,
  notFoundComponent: MedicationsNotFound,
})

export { Route }

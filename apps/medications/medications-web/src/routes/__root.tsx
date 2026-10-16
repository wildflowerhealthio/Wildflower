import { createRootRouteWithContext, retainSearchParams } from '@tanstack/react-router'
import { useFetchEveryPage } from '@wildflowerhealthio/react-kitchen-sink'
import { ChunkBar, RouteTabs } from '@wildflowerhealthio/react-tundraish'
import {
  LoadingLine,
  PatientChoiceLine,
  type PatientChoice,
  ReadFailureLine,
} from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import type { JSX } from 'react'

import {
  type RouterContext,
  type SmartClient,
  useChangePatient,
  useChosenPatient,
  useSmartClient,
} from '../router-context.ts'
import { type MedicationRead, useMedicationRead } from './-medication-read.ts'
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

/** What the medications page shows above and around its tabs. */
interface MedicationsPageModel {
  readonly client: SmartClient
  readonly patientChoice: PatientChoice
  readonly changePatient: () => void
  readonly read: MedicationRead
}

/**
 * The medications page's logic: whose medications, their read, and the
 * driver that reads every remaining page while the reader has asked for
 * them. The driver runs here, once for the page, so it keeps going as the
 * reader changes tabs.
 */
const useMedicationsPage = (): MedicationsPageModel => {
  const read = useMedicationRead()
  useFetchEveryPage(read.pagedQuery, { enabled: read.everyPageRequested })
  return {
    client: useSmartClient(),
    patientChoice: useChosenPatient(),
    changePatient: useChangePatient(),
    read,
  }
}

/**
 * The medications page: the patient line and the chunk bar tracking the
 * paged read, over the tabs, each a child route the strip links to:
 * Medications, the list; Calendar, the prescription calendar; Interactions,
 * the report over the current medications; Savings, the savings-program
 * breakdown. Until the first page lands the tabs wait behind a loading line,
 * or the read's failure.
 */
function MedicationsPage(): JSX.Element {
  const { client, patientChoice, changePatient, read } = useMedicationsPage()
  const { pagedQuery, pagesReceived } = read
  return (
    <>
      <div className={styles['medications-page__status']}>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={changePatient}
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

/**
 * The root route: the medications page, each of whose tabs is a child route.
 *
 * @remarks
 * Every navigation keeps the page's query: `?patient=`, which
 * `usePatientChoice` writes when the reader picks a patient, stays in the
 * address bar as the reader changes tabs.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  search: { middlewares: [retainSearchParams(true)] },
  component: MedicationsPage,
})

export { Route }

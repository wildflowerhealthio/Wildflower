import { useNavigate } from '@tanstack/react-router'
import { useFetchEveryPage } from '@wildflowerhealthio/react-kitchen-sink'
import { ChunkBar } from '@wildflowerhealthio/react-tundraish'
import {
  LoadingLine,
  PatientChoiceLine,
  ReadFailureLine,
  usePathPatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import type { JSX } from 'react'

import { useSmartClient } from '../router-context.ts'
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

/** Props for {@link MedicationsPage}. */
interface MedicationsPageProps {
  /** The tab strip, its links under the page's own path. */
  readonly tabs: JSX.Element
}

/**
 * The medications page's logic: the open route's read, and the driver that
 * reads every remaining page while the reader has asked for them. The
 * driver runs here, once for the page, so it keeps going as the reader
 * changes tabs.
 */
const useMedicationsPage = (): MedicationRead => {
  const read = useMedicationRead()
  useFetchEveryPage(read.pagedQuery, { enabled: read.everyPageRequested })
  return read
}

/**
 * The medications page, one patient's or every patient's, whichever the
 * path names (`usePathPatientChoice`, as the read): the patient line
 * (whose "Change patient" pushes the picker) and the chunk bar tracking the
 * paged read, over `tabs`, each a child route the strip links to:
 * Medications, the list; Calendar, the prescription calendar; Interactions
 * (one patient's page only), the report over the current medications;
 * Savings, the savings-program breakdown. Until the first page lands the tabs wait behind a loading line,
 * or the read's failure.
 */
function MedicationsPage({ tabs }: MedicationsPageProps): JSX.Element {
  const client = useSmartClient()
  const patientChoice = usePathPatientChoice()
  const navigate = useNavigate()
  const read = useMedicationsPage()
  const { pagedQuery, pagesReceived } = read
  return (
    <>
      <div className={styles['medications-page__status']}>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={() => {
            void navigate({ to: '/patients' })
          }}
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
        Match.orElse(() => tabs)
      )}
    </>
  )
}

export { MedicationsPage }

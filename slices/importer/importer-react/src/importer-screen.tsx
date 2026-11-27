import { GateCard, Notice } from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import { ImportCompleteNotice } from './plan/import-complete-notice.tsx'
import { ImportPlanPage } from './plan/import-plan-page.tsx'
import { CHOOSE_OTHER_FILES_LABEL, READ_FAILED_MESSAGE, READING_MESSAGE } from './plan/plan-text.ts'
import { settingsStatusOf, useImportPlanPage } from './plan/use-import-plan-page.ts'
import { formatRegistry } from './registry.ts'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: choose files, read them into an
 * import plan against the existing records, review the plan, and write it as
 * one transaction.
 *
 * @remarks
 * The screen is the opt-in seam made visible: reading and planning only
 * search and read, and only the explicit Import writes. The slice owns every
 * level of this flow rather than the host app: an app mounts only this
 * screen. Mount it inside the host's router and `QueryClientProvider` — the
 * authed runner and the FHIR client both come from router context via
 * `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The registered formats' detectors, in registry (priority) order. */
const registeredDetectors = Object.values(formatRegistry)

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const page = useImportPlanPage()
  const body = Match.value(page.state).pipe(
    Match.tag('ChoosingFiles', () => (
      <SourcePicker detectors={registeredDetectors} onPick={page.read} />
    )),
    Match.tag('Reading', () => <GateCard title={READING_MESSAGE} />),
    Match.tag('ReadFailed', () => (
      <Notice tone="danger" action={{ label: CHOOSE_OTHER_FILES_LABEL, onClick: page.startOver }}>
        {READ_FAILED_MESSAGE}
      </Notice>
    )),
    Match.tag('Reviewing', ({ review, writeFailure, isRereading, choicesNotKept }) => (
      <ImportPlanPage
        review={review}
        writeFailure={writeFailure}
        importing={false}
        settings={page.settings}
        settingsStatus={settingsStatusOf(review, isRereading, page.settings)}
        choicesNotKept={choicesNotKept.length}
        onChoose={page.choose}
        onReset={page.reset}
        onApplySettings={page.applySettings}
        onApplySettingsAgain={page.applySettingsAgain}
        onImport={page.importPlan}
        onCancel={page.startOver}
      />
    )),
    Match.tag('Importing', ({ review }) => (
      <ImportPlanPage
        review={review}
        writeFailure={Option.none()}
        importing
        settings={page.settings}
        settingsStatus={settingsStatusOf(review, false, page.settings)}
        choicesNotKept={0}
        onChoose={page.choose}
        onReset={page.reset}
        onApplySettings={page.applySettings}
        onApplySettingsAgain={page.applySettingsAgain}
        onImport={page.importPlan}
        onCancel={page.startOver}
      />
    )),
    Match.tag('Imported', ({ review }) => (
      <ImportCompleteNotice totals={review.totals} onImportMore={page.startOver} />
    )),
    Match.exhaustive
  )
  return <div className={styles['importer-screen']}>{body}</div>
}

export { ImporterScreen }

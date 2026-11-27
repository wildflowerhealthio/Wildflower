import type { FormatKind, FormatSettings } from '@wildflowerhealthio/importer-core'
import {
  FormatDecode,
  type RecordChoice,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { Match } from 'effect'
import { type JSX, useId, useMemo } from 'react'

import { FileSection } from './file-section.tsx'
import { PeopleSection } from './people-section.tsx'
import * as PlanSections from './plan-sections.ts'
import {
  DECIDED_AUTOMATICALLY_HEADING,
  DECIDED_AUTOMATICALLY_KICKER,
  decidedAutomaticallyLine,
} from './plan-text.ts'
import type { Review } from './use-import-plan-page.ts'
import styles from './decided-automatically.module.css'

/** What {@link DecidedAutomatically} shows and does. */
interface DecidedAutomaticallyProps {
  readonly review: Review
  /** Whether the write is in flight: nothing can be changed until it settles. */
  readonly importing: boolean
  /** Every format's settings as the reviewer last set them. */
  readonly settings: FormatSettings
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
  readonly onApplySettings: <K extends FormatKind>(
    format: K,
    formatSettings: FormatSettings[K]
  ) => void
}

/**
 * The records that need no decision (`PlanSections.sectionsOf`), under a
 * divider, the kicker, the heading and how many there are, when there are
 * any: the people, then one section per file set, with its notes and its
 * format's Settings. Nothing when there is no section. While the write is
 * in flight one `<fieldset disabled>` disables every control in it, the
 * settings among them.
 */
const DecidedAutomatically = ({
  review,
  importing,
  settings,
  onChoose,
  onReset,
  onApplySettings,
}: DecidedAutomaticallyProps): JSX.Element | null => {
  const sections = useMemo(() => PlanSections.sectionsOf(review), [review])
  const headingDomId = useId()
  if (sections.length === 0) return null
  const records = PlanSections.recordCountOf(sections)
  return (
    <section aria-labelledby={headingDomId} className={styles['decided-automatically']}>
      <div className={styles['decided-automatically__heading']}>
        <span className={styles['decided-automatically__kicker']}>
          {DECIDED_AUTOMATICALLY_KICKER}
        </span>
        <h2 id={headingDomId} className={styles['decided-automatically__title']}>
          {DECIDED_AUTOMATICALLY_HEADING}
        </h2>
        {records === 0 ? null : (
          <p className={styles['decided-automatically__line']}>
            {decidedAutomaticallyLine(records)}
          </p>
        )}
      </div>
      <fieldset
        disabled={importing}
        aria-labelledby={headingDomId}
        className={styles['decided-automatically__sections']}
      >
        {sections.map((section) =>
          Match.value(section).pipe(
            Match.tag('People', ({ groups }) => (
              <PeopleSection key="people" groups={groups} onChoose={onChoose} onReset={onReset} />
            )),
            Match.tag('FileSet', ({ origin, format, groups, notes, formatFileSets }) => (
              <FileSection
                key={FormatDecode.makeId(origin.format, origin.pickedFiles)}
                origin={origin}
                format={format}
                groups={groups}
                notes={notes}
                formatFileSets={formatFileSets}
                settings={settings}
                onChoose={onChoose}
                onReset={onReset}
                onApplySettings={onApplySettings}
              />
            )),
            Match.exhaustive
          )
        )}
      </fieldset>
    </section>
  )
}

export { DecidedAutomatically }
export type { DecidedAutomaticallyProps }

import type { RecordChoice, RecordKey } from '@wildflowerhealthio/importer-fundamentals'
import { type JSX, useId } from 'react'

import type * as PlanSections from './plan-sections.ts'
import { PEOPLE_HEADING, PEOPLE_LINE } from './plan-text.ts'
import { RecordGroup } from './record-group.tsx'
import styles from './people-section.module.css'

/** What {@link PeopleSection} shows and does. */
interface PeopleSectionProps {
  readonly groups: readonly PlanSections.Group[]
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  readonly onReset: (keys: Iterable<RecordKey.Type>) => void
}

/**
 * The Patients and Practitioners decided automatically, whichever file
 * brought them: the heading, the line saying other records reference them,
 * and one group per type.
 */
const PeopleSection = ({ groups, onChoose, onReset }: PeopleSectionProps): JSX.Element => {
  const headingDomId = useId()
  return (
    <section aria-labelledby={headingDomId} className={styles['people-section']}>
      <div className={styles['people-section__heading']}>
        <h3 id={headingDomId} className={styles['people-section__title']}>
          {PEOPLE_HEADING}
        </h3>
        <p className={styles['people-section__line']}>{PEOPLE_LINE}</p>
      </div>
      {groups.map((group) => (
        <RecordGroup
          key={group.resourceType}
          group={group}
          sectionTag="People"
          onChoose={onChoose}
          onReset={onReset}
        />
      ))}
    </section>
  )
}

export { PeopleSection }
export type { PeopleSectionProps }

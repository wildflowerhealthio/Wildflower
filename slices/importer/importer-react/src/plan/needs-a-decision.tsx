import {
  PlannedRecord,
  type RecordChoice,
  type RecordKey,
  RecordReferences,
} from '@wildflowerhealthio/importer-fundamentals'
import type { JSX } from 'react'

import { decisionCardDomId, recordKeyText } from './decision-card-ids.ts'
import { DecisionCard } from './decision-card.tsx'
import * as PlanDifferences from './plan-differences.ts'
import { CountLabel, NEEDS_A_DECISION_LINE } from './plan-text.ts'
import type { Review } from './use-import-plan-page.ts'
import styles from './needs-a-decision.module.css'

/** What {@link NeedsADecision} shows and does. */
interface NeedsADecisionProps {
  readonly review: Review
  /** Whether the write is in flight: no choice can be made until it settles. */
  readonly importing: boolean
  readonly onChoose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
}

/**
 * The records that need a decision, one card each in plan order, under the
 * heading and why they are asked about; nothing when no record needs one.
 * A record stays listed once it is decided. Each card's DOM id is the
 * record's index in the plan, which the import bar finds it by.
 */
const NeedsADecision = ({
  review,
  importing,
  onChoose,
}: NeedsADecisionProps): JSX.Element | null => {
  const records = review.plan.records.flatMap((planned, index) =>
    PlannedRecord.needsDecision(planned) ? [{ planned, index }] : []
  )
  if (records.length === 0) return null
  return (
    <section aria-label={CountLabel.NeedsDecision} className={styles['needs-a-decision']}>
      <div className={styles['needs-a-decision__heading']}>
        <h2 className={styles['needs-a-decision__title']}>{CountLabel.NeedsDecision}</h2>
        <p className={styles['needs-a-decision__line']}>{NEEDS_A_DECISION_LINE}</p>
      </div>
      {records.map(({ planned, index }) => {
        const { key } = planned.record
        const handleChoose = (choice: RecordChoice.Type): void => {
          onChoose([key], choice)
        }
        return (
          <DecisionCard
            key={recordKeyText(key)}
            planned={planned}
            now={review.readAt}
            referrers={RecordReferences.referrersOf(review.recordReferences, key).length}
            candidates={PlanDifferences.candidatesOf(review.differences, key)}
            domId={decisionCardDomId(index)}
            importing={importing}
            onChoose={handleChoose}
          />
        )
      })}
    </section>
  )
}

export { NeedsADecision }
export type { NeedsADecisionProps }

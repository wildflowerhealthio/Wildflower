import { type BatchEntryOutcome, groupByStatus, type StatusGroup } from 'fhir-r4/clients'
import type { JSX } from 'react'

import { countOf } from './count-of.ts'
import styles from './load-results.module.css'

/** Heading when every resource wrote. */
const COMPLETE_HEADING = 'Snapshot loaded'

/** Heading when at least one resource did not. */
const PARTIAL_HEADING = 'Loaded with some failures'

/** One resource's `Type/id`, as the server addressed it. */
const targetLabel = (outcome: BatchEntryOutcome): string =>
  `${outcome.target.label}/${outcome.target.id}`

/** One resource's row: its `Type/id` and any diagnostics the server attached. */
const OutcomeRow = ({ outcome }: { readonly outcome: BatchEntryOutcome }): JSX.Element => (
  <li className={styles.row}>
    <span className={styles.target}>{targetLabel(outcome)}</span>
    {outcome.issues.length > 0 && (
      <ul className={styles.issues}>
        {outcome.issues.map((issue) => (
          <li key={`${issue.severity}:${issue.code}:${issue.text}`} className={styles.issue}>
            <span className={styles.issueCode}>
              {issue.severity}
              {issue.code === '' ? '' : ` · ${issue.code}`}
            </span>
            {issue.text !== '' && <span>{issue.text}</span>}
          </li>
        ))}
      </ul>
    )}
  </li>
)

/** A status and its resources, folded away when it succeeded and open when it failed. */
const StatusSection = ({
  group,
}: {
  readonly group: StatusGroup<BatchEntryOutcome>
}): JSX.Element => (
  <details className={styles.section} open={!group.ok} data-status-ok={group.ok}>
    <summary className={styles.summary}>
      {group.status} · {countOf(group.outcomes.length, 'resource')}
    </summary>
    <ul className={styles.rows}>
      {group.outcomes.map((outcome) => (
        <OutcomeRow key={targetLabel(outcome)} outcome={outcome} />
      ))}
    </ul>
  </details>
)

/** Props for {@link LoadResults}. */
interface LoadResultsProps {
  /** Every written resource's outcome. */
  readonly outcomes: readonly BatchEntryOutcome[]
  /** Called to put the results away and load again. */
  readonly onDone: () => void
}

/**
 * What a load wrote: how many resources the server accepted, and every
 * resource grouped by the status it answered, failures first with the
 * server's own messages.
 */
const LoadResults = ({ outcomes, onDone }: LoadResultsProps): JSX.Element => {
  const written = outcomes.filter((outcome) => outcome.ok).length
  return (
    <section aria-label="Load results" className={styles.results}>
      <h2 className="text-heading-5">
        {written === outcomes.length ? COMPLETE_HEADING : PARTIAL_HEADING}
      </h2>
      <p role="status">
        Wrote {written} of {countOf(outcomes.length, 'resource')}.
      </p>
      <div className={styles.groups}>
        {groupByStatus(outcomes).map((group) => (
          <StatusSection key={group.status} group={group} />
        ))}
      </div>
      <div>
        <button type="button" className="button-2" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  )
}

export { COMPLETE_HEADING, LoadResults, type LoadResultsProps, PARTIAL_HEADING }

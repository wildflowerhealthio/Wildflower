import type { BatchEntryOutcome, WriteIssue } from 'fhir-r4/clients'
import type { JSX } from 'react'

import { plural } from './plural.ts'
import styles from './load-results.module.css'

/**
 * What a load wrote and what it could not, in the importer's results
 * vocabulary: every resource grouped by the status the server echoed for it,
 * failures first and open with the server's own diagnostics, successes folded
 * away.
 */

/** Heading when every resource wrote. */
const COMPLETE_HEADING = 'Load complete'

/** Heading when the server rejected at least one resource. */
const PARTIAL_HEADING = 'Loaded with some failures'

/** One echoed status and the resources that got it. */
interface StatusGroup {
  /** `"201 Created"`, `"422 Unprocessable Entity"`, `"No response"`. */
  readonly status: string
  readonly ok: boolean
  readonly outcomes: readonly BatchEntryOutcome[]
}

/** The leading HTTP code of a status, or `NaN` for `"No response"`. */
const statusCode = (status: string): number => Number.parseInt(status, 10)

/**
 * The outcomes grouped by status: failures before successes, then by
 * ascending code, a status with no code last in its band.
 */
const groupByStatus = (outcomes: readonly BatchEntryOutcome[]): readonly StatusGroup[] => {
  const groups = new Map<string, BatchEntryOutcome[]>()
  for (const outcome of outcomes) {
    const group = groups.get(outcome.status)
    if (group === undefined) groups.set(outcome.status, [outcome])
    else group.push(outcome)
  }
  return [...groups]
    .map(([status, grouped]): StatusGroup => ({
      status,
      ok: grouped.every((outcome) => outcome.ok),
      outcomes: grouped,
    }))
    .toSorted((left, right) => {
      if (left.ok !== right.ok) return left.ok ? 1 : -1
      const leftCode = statusCode(left.status)
      const rightCode = statusCode(right.status)
      if (Number.isNaN(leftCode)) return Number.isNaN(rightCode) ? 0 : 1
      if (Number.isNaN(rightCode)) return -1
      return leftCode - rightCode
    })
}

/** A resource's `Type/id`, as the server addressed it. */
const targetLabelOf = (outcome: BatchEntryOutcome): string =>
  `${outcome.target.label}/${outcome.target.id}`

const IssueLine = ({ issue }: { readonly issue: WriteIssue }): JSX.Element => (
  <li className={styles.issue}>
    <span className={styles.issueCode}>
      {issue.severity}
      {issue.code === '' ? '' : ` · ${issue.code}`}
    </span>
    {issue.text !== '' && <span>{issue.text}</span>}
  </li>
)

/** One status as a foldable section, open when it is a failure. */
const StatusSection = ({ group }: { readonly group: StatusGroup }): JSX.Element => (
  <details className={styles.statusSection} open={!group.ok} role={group.ok ? undefined : 'alert'}>
    <summary className={styles.statusSummary} data-status-ok={group.ok}>
      {group.status} · {group.outcomes.length} {plural(group.outcomes.length, 'resource')}
    </summary>
    <ul className={styles.outcomeList}>
      {group.outcomes.map((outcome) => (
        <li key={targetLabelOf(outcome)} className={styles.outcome}>
          <span className={styles.target}>{targetLabelOf(outcome)}</span>
          {outcome.issues.length > 0 && (
            <ul className={styles.issueList}>
              {outcome.issues.map((issue) => (
                <IssueLine key={`${issue.severity}:${issue.code}:${issue.text}`} issue={issue} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  </details>
)

/** Props for {@link LoadResults}. */
interface LoadResultsProps {
  /** One outcome per resource the load submitted. */
  readonly outcomes: readonly BatchEntryOutcome[]
  /** The names of the people loaded, in the data set's order. */
  readonly peopleNames: readonly string[]
  /** Where the load wrote. */
  readonly serverUrl: string
}

/** The results of a finished load: the heading, the tally, and every resource by status. */
const LoadResults = ({ outcomes, peopleNames, serverUrl }: LoadResultsProps): JSX.Element => {
  const written = outcomes.filter((outcome) => outcome.ok).length
  return (
    <section aria-label="Load results" className={styles.results}>
      <h2 className={styles.heading}>
        {written === outcomes.length ? COMPLETE_HEADING : PARTIAL_HEADING}
      </h2>
      <p role="status" className={styles.summary}>
        Wrote {written} of {outcomes.length} {plural(outcomes.length, 'resource')} for{' '}
        {peopleNames.join(', ')} to {serverUrl}.
      </p>
      <div className={styles.groups}>
        {groupByStatus(outcomes).map((group) => (
          <StatusSection key={group.status} group={group} />
        ))}
      </div>
    </section>
  )
}

export { COMPLETE_HEADING, LoadResults, PARTIAL_HEADING }
export type { LoadResultsProps }

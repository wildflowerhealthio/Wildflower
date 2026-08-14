import type { JSX } from 'react'

import type { ResourceWriteFailure } from 'fhir-r4/clients'

import type { ImportOutcome } from './import-outcome.ts'
import styles from './import-results.module.css'

/**
 * The results view: what a confirmed import wrote, what it could not, and the
 * archive every written resource now points back to.
 *
 * @remarks
 * A partial import is a first-class outcome, not a failure banner — any resource
 * the store rejected is listed by type and id so the reader knows exactly what
 * did not land, while the resources that did write are already on the device. The
 * `collectImportSummary` semantics decide the framing: any failure at all makes
 * the whole import `partial`, and the failed resources accumulate rather than
 * collapsing to a count.
 *
 * @packageDocumentation
 */

/** Props for {@link ImportResults}. */
interface ImportResultsProps {
  /** The tally the confirm step resolved with. */
  readonly outcome: ImportOutcome
  /** Whether any resource failed to write — the `partial` framing. */
  readonly partial: boolean
  /** Called to discard the results and return to the source picker. */
  readonly onStartOver: () => void
}

/** Heading when every resource wrote. */
const COMPLETE_HEADING = 'Import complete'

/** Heading when at least one resource failed to write. */
const PARTIAL_HEADING = 'Imported with some failures'

/** The failed-resource identity a row shows — the write sink's own `label`/`id`. */
const failureLabel = (failure: ResourceWriteFailure): string =>
  `${failure.failed.label}/${failure.failed.id}`

/**
 * The results surface. Reads the {@link ImportOutcome} and frames it as a
 * complete or partial import, listing every failed resource in the partial case.
 */
const ImportResults = ({ outcome, partial, onStartOver }: ImportResultsProps): JSX.Element => (
  <section aria-label="Import results" className={styles.results}>
    <h2 className={styles.heading}>{partial ? PARTIAL_HEADING : COMPLETE_HEADING}</h2>
    <p role="status" className={styles.summary}>
      Wrote {outcome.written} of {outcome.attempted}{' '}
      {outcome.attempted === 1 ? 'resource' : 'resources'}.
    </p>
    <p className={styles.provenance}>
      Provenance linked to <span className={styles.sourceRef}>{outcome.sourceRef}</span>.
    </p>
    {partial && (
      <div role="alert" className={styles.failures}>
        <p className={styles.failuresHeading}>
          {outcome.failures.length} {outcome.failures.length === 1 ? 'resource' : 'resources'} could
          not be written:
        </p>
        <ul className={styles.failureList}>
          {outcome.failures.map((failure) => (
            <li key={failureLabel(failure)} className={styles.failureRow}>
              {failureLabel(failure)}
            </li>
          ))}
        </ul>
      </div>
    )}
    <div className={styles.actions}>
      <button type="button" className={styles.startOver} onClick={onStartOver}>
        Import another archive
      </button>
    </div>
  </section>
)

export { COMPLETE_HEADING, ImportResults, type ImportResultsProps, PARTIAL_HEADING }

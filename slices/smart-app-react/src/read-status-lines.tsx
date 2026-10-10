import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import type { JSX } from 'react'

import styles from './read-status-lines.module.css'

/**
 * The read-status vocabulary every SMART app's page speaks: `Loading…` (or
 * `Loading medications…`) before anything has landed, `Loading more…` while
 * further pages arrive, and `Could not load observations: <reason>` for a
 * failed read — one line each, so the apps say the same thing the same way.
 *
 * @packageDocumentation
 */

/** Props for {@link LoadingLine}. */
interface LoadingLineProps {
  /** What is loading, e.g. `medications`; left out, the line is `Loading…`. */
  readonly subject?: string
}

/** A read with nothing landed yet: `Loading…`, or `Loading <subject>…`. */
const LoadingLine = ({ subject }: LoadingLineProps): JSX.Element => (
  <p className={styles.status}>{subject === undefined ? 'Loading…' : `Loading ${subject}…`}</p>
)

/** A read with pages landed and more on the way: `Loading more…`. */
const LoadingMoreLine = (): JSX.Element => <p className={styles.status}>Loading more…</p>

/** Props for {@link ReadFailureLine}. */
interface ReadFailureLineProps {
  /** What could not be loaded, e.g. `observations`. */
  readonly subject: string
  /** Why: an `Error`'s message, or the value itself as a string. */
  readonly error: unknown
}

/** A failed read, as one line: `Could not load <subject>: <reason>`. */
const ReadFailureLine = ({ subject, error }: ReadFailureLineProps): JSX.Element => (
  <p className={styles.error}>
    Could not load {subject}: {unknownErrorToString(error)}
  </p>
)

export { LoadingLine, LoadingMoreLine, ReadFailureLine }
export type { LoadingLineProps, ReadFailureLineProps }

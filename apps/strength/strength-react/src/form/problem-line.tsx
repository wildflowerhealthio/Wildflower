import type { JSX } from 'react'

import styles from './problem-line.module.css'

/** A problem with a form field, as the line under it in the danger ramp. */
const ProblemLine = ({ problem }: { readonly problem: string }): JSX.Element => (
  <span className={styles['problem-line']}>{problem}</span>
)

export { ProblemLine }

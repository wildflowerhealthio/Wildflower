import type { JSX } from 'react'

import { ProblemLine } from './problem-line.tsx'

/**
 * A field's problem as its {@link ProblemLine}, or nothing when it has none —
 * what a field's `description` takes, so a field without a problem has no
 * description at all.
 */
const problemDescription = (problem: string | undefined): JSX.Element | undefined =>
  problem === undefined ? undefined : <ProblemLine problem={problem} />

export { problemDescription }

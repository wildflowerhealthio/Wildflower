import { type Severity, severityCodes } from './severity.ts'

/** How many interactions a group holds at each severity. */
type SeverityTally = Readonly<Record<Severity, number>>

const emptyTally: SeverityTally = { major: 0, moderate: 0, minor: 0, unknown: 0 }

/** The tally of a set of rows. */
const tallyOf = (rows: readonly { readonly severity: Severity }[]): SeverityTally => {
  const counts = { ...emptyTally }
  for (const row of rows) counts[row.severity] += 1
  return counts
}

/** The element-wise sum of two tallies. */
const addTallies = (a: SeverityTally, b: SeverityTally): SeverityTally => ({
  major: a.major + b.major,
  moderate: a.moderate + b.moderate,
  minor: a.minor + b.minor,
  unknown: a.unknown + b.unknown,
})

/** Total interactions in a tally. */
const tallyTotal = (tally: SeverityTally): number =>
  tally.major + tally.moderate + tally.minor + tally.unknown

/**
 * Comparator putting the tally with more Major interactions first, ties
 * broken by Moderate, then Minor, then Unknown; `0` for equal tallies.
 */
const compareTallies = (a: SeverityTally, b: SeverityTally): number => {
  for (const severity of severityCodes) {
    const difference = b[severity] - a[severity]
    if (difference !== 0) return difference
  }
  return 0
}

/** The most severe severity present in a tally, or `null` when it is empty. */
const worstSeverity = (tally: SeverityTally): Severity | null =>
  severityCodes.find((severity) => tally[severity] > 0) ?? null

export {
  addTallies,
  compareTallies,
  emptyTally,
  type SeverityTally,
  tallyOf,
  tallyTotal,
  worstSeverity,
}

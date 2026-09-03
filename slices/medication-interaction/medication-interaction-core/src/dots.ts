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

/** The most dots a group header shows before it switches to a proportional mix. */
const dotCap = 14

/**
 * The severities to paint as a group header's dot strip, most severe first.
 *
 * @param tally - The group's interaction counts
 * @param cap - The most dots to return (defaults to {@link dotCap}); at least
 *   the number of severities present in `tally`
 * @returns One severity per dot, Major dots first
 *
 * @remarks
 * Within `cap`, one dot per interaction. Past it, every severity present keeps
 * one dot and the remaining slots are shared by largest remainder (ties most
 * severe first), so a rare Major stays visible where a fill-then-truncate
 * would hide the tail.
 */
const allocateDots = (tally: SeverityTally, cap: number = dotCap): readonly Severity[] => {
  const present = severityCodes.filter((severity) => tally[severity] > 0)
  const total = tallyTotal(tally)
  const perSeverity = new Map<Severity, number>()
  if (total <= cap) {
    for (const severity of present) perSeverity.set(severity, tally[severity])
  } else {
    const spare = cap - present.length
    const shares = present.map((severity) => {
      const exact = (tally[severity] / total) * spare
      const whole = Math.floor(exact)
      return { severity, whole, remainder: exact - whole }
    })
    let left = spare - shares.reduce((sum, share) => sum + share.whole, 0)
    // Stable sort: equal remainders keep their most-severe-first order.
    for (const share of shares.toSorted((x, y) => y.remainder - x.remainder)) {
      if (left === 0) break
      share.whole += 1
      left -= 1
    }
    for (const share of shares) perSeverity.set(share.severity, share.whole + 1)
  }
  return present.flatMap((severity) =>
    Array.from<Severity>({ length: perSeverity.get(severity) ?? 0 }).fill(severity)
  )
}

export {
  addTallies,
  allocateDots,
  compareTallies,
  dotCap,
  emptyTally,
  type SeverityTally,
  tallyOf,
  tallyTotal,
}

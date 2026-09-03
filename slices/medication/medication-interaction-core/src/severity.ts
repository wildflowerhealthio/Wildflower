import { Schema } from 'effect'

/**
 * DDInter's four interaction levels, most severe first. Array position is both
 * the sort rank and the integer code the compact bundled file stores, so the
 * three views of a severity (name, rank, code) can never disagree.
 */
const severityCodes = ['major', 'moderate', 'minor', 'unknown'] as const

/** A DDInter interaction level. */
const Severity = Schema.Literal(...severityCodes)
type Severity = typeof Severity.Type

/** The compact integer form of a {@link Severity}: its index in {@link severityCodes}. */
const SeverityCode = Schema.Literal(0, 1, 2, 3)
type SeverityCode = typeof SeverityCode.Type

/** Display labels. */
const severityLabels: Readonly<Record<Severity, string>> = {
  major: 'Major',
  moderate: 'Moderate',
  minor: 'Minor',
  unknown: 'Unknown',
}

/** Sort rank (lower sorts first): Major before Moderate before Minor before Unknown. */
const severityRank: Readonly<Record<Severity, SeverityCode>> = {
  major: 0,
  moderate: 1,
  minor: 2,
  unknown: 3,
}

/** Comparator ordering severities most-severe first. */
const compareSeverity = (a: Severity, b: Severity): number => severityRank[a] - severityRank[b]

/** The {@link Severity} a compact file code stands for. */
const severityFromCode = (code: SeverityCode): Severity => severityCodes[code]

/** The compact file code for a {@link Severity} (its rank). */
const severityToCode = (severity: Severity): SeverityCode => severityRank[severity]

/**
 * Parse DDInter's `Level` column (`Major` / `Moderate` / `Minor` / `Unknown`,
 * any case, surrounding whitespace ignored); `null` for anything else.
 */
const parseSeverity = (level: string): Severity | null => {
  const lowered = level.trim().toLowerCase()
  return Schema.is(Severity)(lowered) ? lowered : null
}

export {
  compareSeverity,
  parseSeverity,
  Severity,
  SeverityCode,
  severityCodes,
  severityFromCode,
  severityLabels,
  severityRank,
  severityToCode,
}

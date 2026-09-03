import type { JSX } from 'react'
import { StatusBadge } from 'react-tundraish'

import { type Severity, severityLabels } from 'medication-interaction-core'

import { severityTones } from './severity-tone.ts'

interface SeverityBadgeProps {
  readonly severity: Severity
}

/** A `StatusBadge` carrying a DDInter level's label in its tone (see {@link severityTones}). */
export const SeverityBadge = ({ severity }: SeverityBadgeProps): JSX.Element => (
  <StatusBadge tone={severityTones[severity]}>{severityLabels[severity]}</StatusBadge>
)

export type { SeverityBadgeProps }

import { StatusBadge } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { type Severity, severityLabels } from '@wildflowerhealthio/medication-interaction-core-js'

import { severityTones } from './severity-tone.ts'

interface SeverityBadgeProps {
  readonly severity: Severity
}

/** A `StatusBadge` carrying a DDInter level's label in its tone (see {@link severityTones}). */
export const SeverityBadge = ({ severity }: SeverityBadgeProps): JSX.Element => (
  <StatusBadge tone={severityTones[severity]}>{severityLabels[severity]}</StatusBadge>
)

export type { SeverityBadgeProps }

import type { StatusTone } from 'react-tundraish'

import type { Severity } from 'medication-interaction-core'

/**
 * The design-system tone each DDInter level is painted in: Major is danger
 * (red), Moderate warning (gold), Minor info (blue), Unknown neutral.
 */
const severityTones: Readonly<Record<Severity, StatusTone>> = {
  major: 'danger',
  moderate: 'warning',
  minor: 'info',
  unknown: 'neutral',
}

export { severityTones }

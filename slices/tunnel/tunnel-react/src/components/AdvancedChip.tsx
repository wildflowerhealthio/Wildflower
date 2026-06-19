import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './AdvancedChip.module.css'

interface AdvancedChipProps {
  readonly className?: string
}

/**
 * "ADVANCED" chip — a small mono pill marking a destination or
 * section as setup-level config. Shared between the Tunnel overview's
 * "Relay settings" entry row (rendered inline beside the row title)
 * and the Relay settings page header (rendered in the PageHeader
 * actions slot).
 */
const AdvancedChip = ({ className }: AdvancedChipProps): JSX.Element => (
  <span className={cn(styles['chip'], className)}>Advanced</span>
)

export { AdvancedChip }
export type { AdvancedChipProps }

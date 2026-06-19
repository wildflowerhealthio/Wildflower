import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './chip.module.css'

interface ChipProps {
  /** Chip label — usually a short noun like "Advanced", "Beta", "New". */
  readonly children: ReactNode
  readonly className?: string
}

/**
 * Compact mono pill that marks a scope or maturity ("Advanced",
 * "Beta", "Preview") beside a title or row. Renders the label in
 * uppercase via `text-transform` so the consumer can pass natural
 * case (`<Chip>Advanced</Chip>`) and have it typeset consistently
 * with the rest of the chip family.
 */
const Chip = ({ children, className }: ChipProps): JSX.Element => (
  <span className={cn(styles['chip'], className)}>{children}</span>
)

export { Chip }
export type { ChipProps }

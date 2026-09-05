import type { JSX, MouseEventHandler, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './link-button.module.css'

interface LinkButtonProps {
  readonly onClick: MouseEventHandler<HTMLButtonElement>
  readonly children: ReactNode
  readonly className?: string
}

/**
 * A button that reads as **link text** — underlined accent text with no box —
 * for an action that lives inside prose or a compact surface (a tooltip, a
 * banner, a loader card) where a boxed button would overpower the copy. It is
 * a real `<button>`, not an `<a>`: the action mutates state rather than
 * navigating.
 */
const LinkButton = ({ onClick, children, className }: LinkButtonProps): JSX.Element => (
  <button type="button" className={cn(styles['link'], className)} onClick={onClick}>
    {children}
  </button>
)

export { LinkButton }
export type { LinkButtonProps }

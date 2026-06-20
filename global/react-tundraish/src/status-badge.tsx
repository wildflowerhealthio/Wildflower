import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

type StatusBadgeProps = {
  readonly tone?: StatusTone
  readonly children: ReactNode
  readonly className?: string
  /**
   * Pulse the leading dot as a liveliness cue (an "Online" tunnel, a
   * "Live" feed). Off by default — opt in only where the badge is
   * actively kept fresh. Respects `prefers-reduced-motion` (the
   * animation is cancelled there).
   */
  readonly pulse?: boolean
}

const toneToAccent: Record<Exclude<StatusTone, 'neutral'>, string> = {
  info: 'accent-blue',
  success: 'accent-green',
  warning: 'accent-yellow',
  danger: 'accent-red',
}

const toneToSrLabel: Record<Exclude<StatusTone, 'neutral' | 'info'>, string> = {
  success: 'Success: ',
  warning: 'Warning: ',
  danger: 'Error: ',
}

const StatusBadge = ({
  tone = 'neutral',
  children,
  className,
  pulse = false,
}: StatusBadgeProps): JSX.Element => {
  const accentClass = tone === 'neutral' ? null : toneToAccent[tone]
  const srLabel = tone === 'neutral' || tone === 'info' ? null : toneToSrLabel[tone]
  return (
    <span
      className={cn('status-badge', accentClass, pulse ? 'pulse' : null, className)}
      role="status"
    >
      {srLabel !== null ? <span className="sr-only">{srLabel}</span> : null}
      {children}
    </span>
  )
}

export { StatusBadge, type StatusBadgeProps, type StatusTone }

import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

type StatusBadgeProps = {
  readonly tone?: StatusTone
  readonly children: ReactNode
  readonly className?: string
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

const StatusBadge = ({ tone = 'neutral', children, className }: StatusBadgeProps): JSX.Element => {
  const accentClass = tone === 'neutral' ? null : toneToAccent[tone]
  const srLabel = tone === 'neutral' || tone === 'info' ? null : toneToSrLabel[tone]
  return (
    <span className={cn('status-badge', accentClass, className)} role="status">
      {srLabel !== null ? <span className="sr-only">{srLabel}</span> : null}
      {children}
    </span>
  )
}

export { StatusBadge, type StatusBadgeProps, type StatusTone }

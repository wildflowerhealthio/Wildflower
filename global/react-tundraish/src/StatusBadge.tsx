import type { JSX, ReactNode } from 'react'

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

type StatusBadgeProps = {
  readonly tone?: StatusTone
  readonly children: ReactNode
  readonly className?: string
}

const toneToAccent: Record<StatusTone, string> = {
  neutral: '',
  info: 'accent-blue',
  success: 'accent-green',
  warning: 'accent-yellow',
  danger: 'accent-red',
}

const StatusBadge = ({ tone = 'neutral', children, className }: StatusBadgeProps): JSX.Element => {
  const accentClass = toneToAccent[tone]
  const classes = ['status-badge', accentClass, className]
    .filter((c) => c !== '' && c !== undefined)
    .join(' ')
  return <span className={classes}>{children}</span>
}

export { StatusBadge, type StatusBadgeProps, type StatusTone }

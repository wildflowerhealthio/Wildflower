import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import pageLayout from './page-layout.module.css'

interface PageErrorProps {
  /** Heading shown above the error message; omit for a bare error panel. */
  readonly title?: string
  /** The thrown / rejected value. `Error` instances surface their `.message`; everything else is stringified. */
  readonly error: unknown
  readonly className?: string
  readonly titleClassName?: string
}

/** Page-level error panel with optional heading. */
const PageError = ({ title, error, className, titleClassName }: PageErrorProps): JSX.Element => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className={cn(pageLayout['page'], className)}>
      {title === undefined ? null : (
        <h1 className={cn('text-heading-4', titleClassName)}>{title}</h1>
      )}
      <p className={cn(pageLayout['error'], 'text-body-3')}>{message}</p>
    </div>
  )
}

export { PageError }
export type { PageErrorProps }

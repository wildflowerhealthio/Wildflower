import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import pageLayout from './page-layout.module.css'

interface PageErrorProps {
  /** Heading shown above the error message; omit for a bare error panel. */
  readonly title?: string
  /** The thrown / rejected value. `Error` instances surface their `.message`; everything else is stringified. */
  readonly error: unknown
  readonly titleClassName?: string
  readonly retry?: () => void
}

/** Page-level error panel with optional heading. */
const PageError = ({ title, error, titleClassName, retry }: PageErrorProps): JSX.Element => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <>
      {title === undefined ? null : (
        <h2 className={cn('text-heading-3', titleClassName)}>{title}</h2>
      )}
      <p className={cn(pageLayout['error'], 'text-body-3')}>{message}</p>
      {retry === undefined ? null : (
        <button type="button" className="button-3 outline" onClick={retry}>
          Retry
        </button>
      )}
    </>
  )
}

export { PageError }
export type { PageErrorProps }

import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import pageLayout from './page-layout.module.css'

interface PageBodyErrorProps {
  /** Sub-heading (h2) shown above the error message; omit for a bare error body. */
  readonly title?: string
  /** The thrown / rejected value. `Error` instances surface their `.message`; everything else is stringified. */
  readonly error: unknown
  readonly titleClassName?: string
  readonly retry?: () => void
}

/**
 * Drop-in error **body** — a fragment, not a page. It renders no container
 * of its own and expects to be slotted into a surrounding page shell (e.g.
 * a layout route's `.page` wrapper) that already supplies the page-level
 * `h1`. The optional `title` renders as an `h2` sub-heading beneath that.
 */
const PageBodyError = ({
  title,
  error,
  titleClassName,
  retry,
}: PageBodyErrorProps): JSX.Element => {
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

export { PageBodyError }
export type { PageBodyErrorProps }

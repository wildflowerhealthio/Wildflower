import { cn } from 'kitchen-sink'
import type { JSX } from 'react'

import pageLayout from '../styles/page-layout.module.css'

interface PageErrorProps {
  /**
   * Heading shown above the error message. Omit for a bare error
   * panel (e.g. inside an `ItemList`-shaped page).
   */
  readonly title?: string
  /** The thrown / rejected value. Stringified safely. */
  readonly error: unknown
  /**
   * Extra class names appended to the outer page div — e.g. a
   * polling-screen layout class to share visual framing with the
   * spinner.
   */
  readonly className?: string
  /**
   * Extra class names appended to the heading — e.g. the
   * red-text variant used by failure states.
   */
  readonly titleClassName?: string
}

/**
 * Page-level error panel with optional heading. Used both by
 * imperative error states (e.g. action handlers that catch and
 * display) and by `<Await errorElement={…}>` fallbacks via
 * `<AsyncErrorView />`.
 */
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

import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { useErrorBodyRenderer, type ErrorBodyRenderer } from './error-body-renderer.ts'
import pageLayout from './page-layout.module.css'

interface PageBodyErrorProps {
  /** Sub-heading (h2) shown above the error message; omit for a bare error body. */
  readonly title?: string
  /** The thrown / rejected value. `Error` instances surface their `.message`; everything else is stringified. */
  readonly error: unknown
  readonly titleClassName?: string
  readonly retry?: () => void
  /**
   * Override how this error body renders. When it returns a node, that node is
   * shown beneath the `title` in place of the default message + retry; when it
   * returns `null`, the default rendering applies. Defaults to the ambient
   * {@link ErrorBodyRendererContext}, so an app can inject bespoke surfaces
   * (e.g. an authorization-failure surface for a 403) once, above the router.
   */
  readonly renderError?: ErrorBodyRenderer
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
  renderError,
}: PageBodyErrorProps): JSX.Element => {
  const heading =
    title === undefined ? null : <h2 className={cn('text-heading-3', titleClassName)}>{title}</h2>

  // A custom renderer (prop, else the ambient context) may own the body for a
  // recognised error shape; `null` falls through to the default message.
  const ambientRenderer = useErrorBodyRenderer()
  const custom = (renderError ?? ambientRenderer)?.(error) ?? null
  if (custom !== null) {
    return (
      <>
        {heading}
        {custom}
      </>
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return (
    <>
      {heading}
      {message.includes('\n') ? (
        // Multi-line messages (Effect Schema ParseError trees etc.)
        // keep their own line structure: a `<pre>` with the same error
        // chrome, monospace so indentation and tree arms line up. No
        // `text-body-*` class — that would override the monospace.
        <pre className={cn(pageLayout['error'], pageLayout['error--multiline'])}>{message}</pre>
      ) : (
        <p className={cn(pageLayout['error'], 'text-body-3')}>{message}</p>
      )}
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

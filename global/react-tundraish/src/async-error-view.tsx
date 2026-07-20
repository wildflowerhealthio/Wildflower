import type { JSX } from 'react'

import type { ErrorBodyRenderer } from './error-body-renderer.ts'
import { PageBodyError } from './page-body-error.tsx'

interface AsyncErrorViewProps {
  /** The error to render; surfaced by a parent error boundary. */
  readonly error: unknown
  /** Sub-heading (h2) shown above the error message; passed straight through to `PageBodyError`. */
  readonly title?: string
  readonly titleClassName?: string
  readonly retry?: () => void
  /** Override how the error body renders; passed straight through to `PageBodyError` (defaults to the ambient renderer). */
  readonly renderError?: ErrorBodyRenderer
}

/**
 * Renders an `error` via {@link PageBodyError}. Like `PageBodyError`, this
 * is an error **body** — a fragment that renders no page container, so it
 * expects to be slotted into a surrounding page shell that supplies the
 * page-level `h1`. Designed to be plugged into a
 * `<CatchBoundary errorComponent>` (TanStack Router) — the `Awaited`
 * wrapper in this package does exactly that for the common
 * "promise rejected → render error" path.
 */
const AsyncErrorView = ({
  error,
  title,
  titleClassName,
  retry,
  renderError,
}: AsyncErrorViewProps): JSX.Element => (
  <PageBodyError
    title={title}
    error={error}
    titleClassName={titleClassName}
    retry={retry}
    renderError={renderError}
  />
)

export { AsyncErrorView }
export type { AsyncErrorViewProps }

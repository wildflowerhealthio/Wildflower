import type { JSX } from 'react'

import { PageError } from './page-error.tsx'

interface AsyncErrorViewProps {
  /** The error to render; surfaced by a parent error boundary. */
  readonly error: unknown
  /** Heading shown above the error message; passed straight through to `PageError`. */
  readonly title?: string
  readonly className?: string
  readonly titleClassName?: string
}

/**
 * Renders an `error` via {@link PageError}. Designed to be plugged into a
 * `<CatchBoundary errorComponent>` (TanStack Router) — the `Awaited`
 * wrapper in this package does exactly that for the common
 * "promise rejected → render error" path.
 */
const AsyncErrorView = ({
  error,
  title,
  className,
  titleClassName,
}: AsyncErrorViewProps): JSX.Element => (
  <PageError title={title} error={error} className={className} titleClassName={titleClassName} />
)

export { AsyncErrorView }
export type { AsyncErrorViewProps }

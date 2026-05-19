import type { JSX } from 'react'
import { useAsyncError } from 'react-router'

import { PageError } from './PageError.tsx'

interface AsyncErrorViewProps {
  /** Heading shown above the error message; passed straight through to `PageError`. */
  readonly title?: string
  readonly className?: string
  readonly titleClassName?: string
}

/** `errorElement` for `<Await>`: renders `useAsyncError()` via {@link PageError}. */
const AsyncErrorView = ({ title, className, titleClassName }: AsyncErrorViewProps): JSX.Element => {
  const error = useAsyncError()
  return (
    <PageError title={title} error={error} className={className} titleClassName={titleClassName} />
  )
}

export { AsyncErrorView }
export type { AsyncErrorViewProps }

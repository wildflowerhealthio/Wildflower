import type { JSX } from 'react'

interface PageLoadingProps {
  /** Override the default "Loading…" copy. */
  readonly message?: string
}

/**
 * Default `<Suspense fallback>` **body** — a fragment, not a self-wrapping
 * page. Renders the loading copy into whatever surrounding shell its
 * `<Suspense>` boundary already sits inside (typically a layout route's
 * `pageLayoutStyles['page']` wrapper), matching the `<PageBodyError>`
 * convention.
 */
const PageLoading = ({ message = 'Loading…' }: PageLoadingProps): JSX.Element => (
  <p className="text-body-2">{message}</p>
)

export { PageLoading }
export type { PageLoadingProps }

import type { JSX } from 'react'

interface PageLoadingProps {
  /**
   * Override the default "Loading…" copy when a screen has a more
   * specific waiting message (e.g. "Starting sign-in…").
   */
  readonly message?: string
}

/**
 * Default `<Suspense fallback>` for screens. Matches the `gk-page`
 * layout so the swap between loading and resolved content keeps the
 * same outer frame.
 */
const PageLoading = ({ message = 'Loading…' }: PageLoadingProps): JSX.Element => (
  <div className="gk-page">
    <p className="text-body-2">{message}</p>
  </div>
)

export { PageLoading }
export type { PageLoadingProps }

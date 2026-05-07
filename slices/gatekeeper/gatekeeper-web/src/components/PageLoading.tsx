import type { JSX } from 'react'

import pageLayout from '../styles/page-layout.module.css'

interface PageLoadingProps {
  /**
   * Override the default "Loading…" copy when a screen has a more
   * specific waiting message (e.g. "Starting sign-in…").
   */
  readonly message?: string
}

/**
 * Default `<Suspense fallback>` for screens. Matches the page layout so
 * the swap between loading and resolved content keeps the same outer
 * frame.
 */
const PageLoading = ({ message = 'Loading…' }: PageLoadingProps): JSX.Element => (
  <div className={pageLayout['page']}>
    <p className="text-body-2">{message}</p>
  </div>
)

export { PageLoading }
export type { PageLoadingProps }

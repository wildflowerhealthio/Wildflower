import type { JSX } from 'react'

import pageLayout from '../styles/page-layout.module.css'

interface PageLoadingProps {
  /** Override the default "Loading…" copy. */
  readonly message?: string
}

/** Default `<Suspense fallback>` matching the page layout. */
const PageLoading = ({ message = 'Loading…' }: PageLoadingProps): JSX.Element => (
  <div className={pageLayout['page']}>
    <p className="text-body-2">{message}</p>
  </div>
)

export { PageLoading }
export type { PageLoadingProps }

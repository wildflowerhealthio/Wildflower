import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

import { TokenTimeoutRetry } from './token-timeout-retry.tsx'

/**
 * `errorComponent` wrapper that supplies the page shell for a top-level
 * auth-gated layout (`_auth`, `/settings`) when its `beforeLoad` rejects.
 *
 * On a `beforeLoad` failure TanStack Router renders the route's
 * `errorComponent` in place of its `component`, *without* rendering the
 * parent layout's own `.page` wrapper — there is none higher in the
 * chain than `__root.tsx`. Centralising the wrap here means
 * `TokenTimeoutRetry` stays a shell-less body, matching the
 * `<PageBodyError>` convention used elsewhere in the app.
 */
const AuthGatedErrorComponent = ({ error }: { readonly error: Error }): JSX.Element => (
  <div className={pageLayoutStyles['page']}>
    <TokenTimeoutRetry error={error} />
  </div>
)

export { AuthGatedErrorComponent }

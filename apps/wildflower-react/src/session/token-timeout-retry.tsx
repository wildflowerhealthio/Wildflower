import { TokenTimeout } from 'gatekeeper-react'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * `errorComponent` for the gated layouts (`_auth`, `/settings`). The
 * embedded `TokenTimeout` is the only error the gate rethrows (the
 * standalone path redirects instead of throwing), so this screen offers
 * a re-attempt: `reset` re-runs the route (and its `beforeLoad`), which
 * awaits the host token again. Reaching here for any other thrown error
 * still surfaces a generic retry rather than a blank page.
 */
const TokenTimeoutRetry = ({
  error,
  reset,
}: {
  readonly error: Error
  readonly reset: () => void
}): JSX.Element => {
  const isTimeout = error instanceof TokenTimeout
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">{isTimeout ? 'Still loading…' : 'Something went wrong'}</h1>
      <p className="text-body-2">
        {isTimeout
          ? "We didn't receive your session in time. Tap retry to keep waiting."
          : error.message}
      </p>
      <button type="button" className="button-2 filled" onClick={reset}>
        Retry
      </button>
    </div>
  )
}

export { TokenTimeoutRetry }

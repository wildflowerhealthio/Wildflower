import { useRouter } from '@tanstack/react-router'
import { TokenTimeout } from 'gatekeeper-react'
import type { JSX } from 'react'
import { pageLayoutStyles } from 'react-tundraish'

/**
 * `errorComponent` for the gated layouts (`_auth`, `/settings`). The
 * embedded `TokenTimeout` is the only error the gate rethrows (the
 * standalone path bubbles a TanStack `redirect` instead of throwing
 * an error), so this screen offers a re-attempt: clicking Retry runs
 * `router.invalidate()` which re-fires the route's `beforeLoad` — and
 * therefore `awaitAuthReady`, which awaits the host token again.
 *
 * `errorComponent`'s `reset` only clears the matched route's local
 * error state (`setState({ error: null })` inside TanStack's
 * `CatchBoundary`); it does NOT re-run `beforeLoad`, so a `reset`-only
 * retry would just paint the same error again as soon as React
 * re-rendered. `router.invalidate()` is the official "rerun every
 * route's loaders + gates" handle.
 *
 * Reaching here for any other thrown error still surfaces a generic
 * retry rather than a blank page.
 */
const TokenTimeoutRetry = ({ error }: { readonly error: Error }): JSX.Element => {
  const router = useRouter()
  const isTimeout = error instanceof TokenTimeout
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">{isTimeout ? 'Still loading…' : 'Something went wrong'}</h1>
      <p className="text-body-2">
        {isTimeout
          ? "We didn't receive your session in time. Tap retry to keep waiting."
          : error.message}
      </p>
      <button
        type="button"
        className="button-2 filled"
        onClick={() => {
          void router.invalidate()
        }}
      >
        Retry
      </button>
    </div>
  )
}

export { TokenTimeoutRetry }

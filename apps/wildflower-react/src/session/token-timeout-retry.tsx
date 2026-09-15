import { useRouter } from '@tanstack/react-router'
import { Match } from 'effect'
import { TokenTimeout } from 'gatekeeper-react'
import { type JSX, useRef } from 'react'
import { Sentry } from 'telemetry-web'

/**
 * `errorComponent` body for the auth-gated layouts; offers a retry that
 * re-runs `awaitAuthReady` via `router.invalidate()`. Any non-timeout
 * thrown error renders a generic retry rather than a blank page.
 *
 * Renders as a fragment, not a page — the surrounding `.page` shell is
 * supplied by `authGatedRouteOptions`' `errorComponent` wrapper so this
 * stays consistent with the rest of the app (route bodies render
 * content; layouts own the shell).
 */
const TOKEN_TIMEOUT_RETRY_THRESHOLD = 3

const TokenTimeoutRetry = ({ error }: { readonly error: unknown }): JSX.Element => {
  const router = useRouter()
  const isTimeout = error instanceof TokenTimeout
  // Surface wedged-host conditions: count consecutive retries this
  // mount and escalate to Sentry once we cross a threshold so we get
  // telemetry on hosts that never deliver the token. The ref is per
  // mount, which matches "consecutive retries against the same wedge."
  const consecutiveTimeoutsRef = useRef(0)

  return (
    <>
      <h1 className="text-heading-6">{isTimeout ? 'Still loading…' : 'Something went wrong'}</h1>
      <p className="text-body-2">
        {Match.value(error).pipe(
          Match.withReturnType<string>(),
          Match.when(
            Match.instanceOf(TokenTimeout),
            () => "We didn't receive your session in time. Tap retry to keep waiting."
          ),
          Match.when(
            (err: unknown): err is { message: string } =>
              typeof err === 'object' &&
              err !== null &&
              'message' in err &&
              typeof err.message === 'string',
            (err) => err.message
          ),
          Match.orElse((err) => String(err))
        )}
      </p>
      <button
        type="button"
        className="button-2 filled"
        onClick={() => {
          if (isTimeout) {
            consecutiveTimeoutsRef.current += 1
            Sentry.addBreadcrumb({
              category: 'auth',
              message: 'TokenTimeoutRetry: retry clicked',
              level: 'info',
              data: { consecutive: consecutiveTimeoutsRef.current },
            })
            if (consecutiveTimeoutsRef.current >= TOKEN_TIMEOUT_RETRY_THRESHOLD) {
              Sentry.captureMessage('TokenTimeoutRetry: wedged-host condition', {
                level: 'warning',
                tags: { feature: 'auth-gate', condition: 'wedged-host' },
                extra: { consecutive: consecutiveTimeoutsRef.current },
              })
            }
          }
          // `router.invalidate()` rerun the route's `beforeLoad` (and
          // therefore `awaitAuthReady`); `errorComponent`'s `reset`
          // only clears local error state and would re-paint the same
          // error.
          void router.invalidate()
        }}
      >
        Retry
      </button>
    </>
  )
}

export { TokenTimeoutRetry }

import { type ErrorRouteComponent, useRouter } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import type { JSX } from 'react'

/**
 * `errorComponent` for a top-level auth-gated layout (`_auth`, `/settings`)
 * when its `beforeLoad` rejects with anything but the gate's redirect: the
 * error's message and a retry that re-runs `awaitAuthReady` via
 * `router.invalidate()`, rather than a blank page.
 *
 * On a `beforeLoad` failure TanStack Router renders the route's
 * `errorComponent` in place of its `component`, *without* rendering the
 * parent layout's own `.page` wrapper — there is none higher in the
 * chain than `__root.tsx` — so this supplies the page shell itself.
 */
const AuthGatedErrorComponent: ErrorRouteComponent = ({
  error,
}: {
  readonly error: unknown
}): JSX.Element => {
  const router = useRouter()
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-6">Something went wrong</h1>
      <p className="text-body-2">
        {Match.value(error).pipe(
          Match.withReturnType<string>(),
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
          // `router.invalidate()` reruns the route's `beforeLoad` (and
          // therefore `awaitAuthReady`); `errorComponent`'s `reset` only
          // clears local error state and would re-paint the same error.
          void router.invalidate()
        }}
      >
        Retry
      </button>
    </div>
  )
}

export { AuthGatedErrorComponent }

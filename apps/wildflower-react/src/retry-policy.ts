import { Duration, Schedule } from 'effect'

import { isUnauthorizedError } from './auth-errors.ts'

/**
 * The retry budgets for the two auth-aware policies the runtime applies: the
 * boot-race re-send schedule the authed runner wraps requests in
 * (`runtime-layer.ts`), and the default attempt count the `QueryClient` keeps
 * for non-auth errors (`query-client.ts`).
 */

/** TanStack Query's own default retry count, preserved for non-401 errors. */
const DEFAULT_QUERY_RETRIES = 3

/** How many times an authed request that comes back 401 is re-sent. */
const UNAUTHORIZED_RETRY_TIMES = 3

/** Spacing between those re-sends — long enough for the Tauri host to finish
 * minting its owner token, short enough to be invisible on a warm boot. */
const UNAUTHORIZED_RETRY_SPACING = Duration.millis(150)

/**
 * Retry policy for the owner-token boot race: re-send only on a 401,
 * {@link UNAUTHORIZED_RETRY_TIMES} times, {@link UNAUTHORIZED_RETRY_SPACING}
 * apart. `whileInput` gates on the 401 test so any other failure propagates on
 * the first attempt instead of being pointlessly re-sent.
 *
 * @remarks
 * The Tauri host binds its loopback listener before it mints the host owner
 * token, and it stamps that token onto direct-loopback requests by connection
 * provenance. A request the webview sends in the gap between the bind and the
 * mint therefore carries no owner bearer and comes back 401; re-sending it
 * shortly after lets the boot succeed without surfacing that transient 401.
 */
const unauthorizedRetrySchedule = Schedule.intersect(
  Schedule.recurs(UNAUTHORIZED_RETRY_TIMES),
  Schedule.spaced(UNAUTHORIZED_RETRY_SPACING)
).pipe(Schedule.whileInput(isUnauthorizedError))

export {
  DEFAULT_QUERY_RETRIES,
  UNAUTHORIZED_RETRY_SPACING,
  UNAUTHORIZED_RETRY_TIMES,
  unauthorizedRetrySchedule,
}

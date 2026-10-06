import {
  queryOptions,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { RequestLogHttpApiClient } from 'request-log-core/clients'
import type { RequestLog } from 'request-log-core/http-api-definition'

import { buildRequestLogClientLayer } from '../client/request-log-client.ts'
import type { RunAuthed } from '../router-context.ts'
import { CALLERS_QUERY_KEY } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

/** What the request log holds for one (caller, client address) pair. */
type CallerSummary = Schema.Schema.Type<typeof RequestLog.CallerSummarySchema>

/**
 * `ListCallers` — one row per (caller, client address), the most recently seen
 * first. Shared by the activity card and the activity page's client summary.
 */
const callersQueryOptions = (
  runAuthed: RunAuthed
): UseQueryOptions<
  readonly CallerSummary[],
  Error,
  readonly CallerSummary[],
  typeof CALLERS_QUERY_KEY
> =>
  queryOptions({
    queryKey: CALLERS_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(RequestLogHttpApiClient, (c) => c.requestLog.ListCallers()).pipe(
          Effect.provide(buildRequestLogClientLayer())
        )
      ),
  })

/**
 * Not a suspense query: the log is secondary to the screens that show it, so a
 * failed read renders in place rather than replacing the page.
 */
const useCallersQuery = (): UseQueryResult<readonly CallerSummary[], Error> =>
  useQuery(callersQueryOptions(useRunAuthed()))

export { callersQueryOptions, useCallersQuery }
export type { CallerSummary }

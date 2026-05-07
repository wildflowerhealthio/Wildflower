import { Effect, Schedule, Stream, type Duration, type Schema } from 'effect'

import type * as OAuth from '../http-api-definition/oauth.ts'
import {
  GatekeeperHttpApiClient,
  type GatekeeperHttpApiClientShape,
} from './gatekeeper-http-api-client.ts'

type AuthorizationStatus = Schema.Schema.Type<typeof OAuth.AuthorizationStatusSchema>

/**
 * Error channel of `/oauth/authorize/:id` — the typed errors the
 * endpoint can produce (404 + 500 + decode failures + transport
 * failures), inferred from the resolved client method so this stays
 * in sync if the endpoint adds another `.addError(...)`.
 */
type AuthorizationStatusError = Effect.Effect.Error<
  ReturnType<GatekeeperHttpApiClientShape['oauth']['AuthorizationStatus']>
>

interface PollAuthorizationStatusOptions {
  /**
   * Polling cadence. Defaults to 1.5 seconds — matches the
   * server-rendered HTML polling page that this stream replaces.
   */
  readonly interval?: Duration.DurationInput
  /**
   * Per-request retry schedule for transient HTTP errors. After
   * the schedule exhausts, the underlying error surfaces on the
   * stream's error channel (it isn't swallowed). Defaults to
   * exponential 1s back-off bounded to ~30s of total retry time.
   */
  readonly retrySchedule?: Schedule.Schedule<Duration.Duration>
}

const DEFAULT_INTERVAL: Duration.DurationInput = '1500 millis'

const defaultRetrySchedule: Schedule.Schedule<Duration.Duration> = Schedule.exponential(
  '1 seconds'
).pipe(Schedule.upTo('30 seconds'))

/**
 * Poll `/oauth/authorize/:id` until the issuer reaches a terminal
 * status (`approved` / `denied` / `error`), emitting every status
 * the server returns along the way (including intermediate
 * `pending` values, which UI consumers can use as heartbeats).
 *
 * Errors surface on the stream's error channel rather than being
 * swallowed — the polling loop only retries within the supplied
 * `retrySchedule`. The stream completes after emitting the first
 * non-`pending` status; consumers that use {@link useStream} or
 * `Stream.runLast` will see that terminal value as the resolved
 * result.
 */
const pollAuthorizationStatus = (
  id: string,
  options?: PollAuthorizationStatusOptions
): Stream.Stream<AuthorizationStatus, AuthorizationStatusError, GatekeeperHttpApiClient> =>
  Stream.repeatEffectWithSchedule(
    Effect.flatMap(GatekeeperHttpApiClient, (c) =>
      c.oauth.AuthorizationStatus({ path: { id } })
    ).pipe(Effect.retry({ schedule: options?.retrySchedule ?? defaultRetrySchedule })),
    Schedule.spaced(options?.interval ?? DEFAULT_INTERVAL)
  ).pipe(Stream.takeUntil((s) => s.status !== 'pending'))

export {
  pollAuthorizationStatus,
  type AuthorizationStatus,
  type AuthorizationStatusError,
  type PollAuthorizationStatusOptions,
}

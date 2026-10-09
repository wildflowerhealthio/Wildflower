import { DateTime, Option } from 'effect'
import { LaunchError, ServerStatus } from 'servers-core'

import { lastStopText } from './server-status-text.ts'

/**
 * Why a running server can't be launched yet, for each refusal the host
 * answers from its status but `serverNotRunning`.
 */
const REFUSAL_REASON: Readonly<
  Record<Exclude<LaunchError.StatusRefusalKind, 'serverNotRunning'>, string>
> = {
  notYetProbed: "The server hasn't been reached through its relay yet.",
  unreachable: "The server can't be reached through its relay.",
  noValidCertificate: 'The server has no valid certificate yet.',
  untrustedCertificate:
    "The server's certificate is from Let's Encrypt's staging CA, which browsers don't trust.",
}

/**
 * Where the wait for a started server stands, from its status: it can be
 * launched; it can't yet, and why; or it won't be, and why.
 */
type WaitOutcome =
  | { readonly kind: 'launchable' }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'gaveUp'; readonly failure: string }

/** The host's reason a running server can't be reached, as a sentence. */
const unreachableReason = (status: ServerStatus.Type): string =>
  ServerStatus.healthOf(status).pipe(
    Option.filter(
      (health): health is Extract<ServerStatus.Health, { readonly kind: 'unreachable' }> =>
        health.kind === 'unreachable'
    ),
    Option.map((health) => health.error),
    Option.match({
      onNone: () => REFUSAL_REASON.unreachable,
      onSome: (error) => `The server can't be reached through its relay: ${error}`,
    })
  )

/**
 * How the server's latest run stopped, when it stopped after the wait began
 * at `confirmedAt`; a stop at that same instant was before it.
 */
const stopDuringWait = (
  status: ServerStatus.Type,
  confirmedAt: DateTime.Utc
): Option.Option<ServerStatus.RunStop> =>
  ServerStatus.lastStopOf(status).pipe(
    Option.filter((stop) => DateTime.greaterThan(stop.stoppedAt, confirmedAt))
  )

/**
 * Why waiting for the server whose status is `status`, since `confirmedAt`,
 * can't help: its run stopped with an error during the wait (a server
 * retrying after one shows that stop while it waits to start again), its
 * certificate order is failing, its certificate is from a CA browsers don't
 * trust, or it can't be reached through its relay while its certificate is
 * valid; none while waiting still can.
 */
const failureOf = (status: ServerStatus.Type, confirmedAt: DateTime.Utc): Option.Option<string> => {
  const stopError = stopDuringWait(status, confirmedAt).pipe(Option.flatMap((stop) => stop.error))
  if (Option.isSome(stopError)) {
    return Option.some(`The server stopped with an error: ${stopError.value}`)
  }
  if (status.certificate.status === 'orderFailing') {
    return Option.some("Ordering the server's certificate is failing.")
  }
  const refusal = Option.getOrNull(LaunchError.statusRefusalOf(status))
  if (refusal === 'untrustedCertificate') return Option.some(REFUSAL_REASON.untrustedCertificate)
  if (refusal !== 'unreachable') return Option.none()
  // Until its certificate is valid, an unreachable server is still getting
  // one.
  return Option.match(LaunchError.certificateRefusalOf(status.certificate), {
    onNone: () => Option.some(unreachableReason(status)),
    onSome: () => Option.none(),
  })
}

/**
 * Why the server whose status is `status` can't be launched yet, its wait
 * having begun at `confirmedAt`: the host's refusal, or, until its run is up,
 * that it is starting or how its run stopped during the wait; none once it
 * can be launched.
 */
const waitingReasonOf = (
  status: ServerStatus.Type,
  confirmedAt: DateTime.Utc
): Option.Option<string> =>
  LaunchError.statusRefusalOf(status).pipe(
    Option.map((refusal) => {
      if (refusal === 'unreachable') return unreachableReason(status)
      if (refusal !== 'serverNotRunning') return REFUSAL_REASON[refusal]
      if (status.runState === 'starting') return 'The server is starting.'
      return stopDuringWait(status, confirmedAt).pipe(
        Option.map(lastStopText),
        Option.getOrElse(() => "The server hasn't started yet.")
      )
    })
  )

/**
 * Where the wait for the server whose status is `status`, begun at
 * `confirmedAt`, stands: it gives up once waiting can't help (`failureOf`),
 * waits while the server can't be launched yet (`waitingReasonOf`), and is
 * otherwise launchable.
 */
const waitOutcomeOf = (status: ServerStatus.Type, confirmedAt: DateTime.Utc): WaitOutcome =>
  failureOf(status, confirmedAt).pipe(
    Option.map((failure): WaitOutcome => ({ kind: 'gaveUp', failure })),
    Option.orElse(() =>
      waitingReasonOf(status, confirmedAt).pipe(
        Option.map((reason): WaitOutcome => ({ kind: 'waiting', reason }))
      )
    ),
    Option.getOrElse((): WaitOutcome => ({ kind: 'launchable' }))
  )

export { REFUSAL_REASON, waitOutcomeOf }
export type { WaitOutcome }

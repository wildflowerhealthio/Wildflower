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
 * How the server's latest run stopped, once it has stopped since the wait
 * began: a stop at `stoppedBeforeStart` is the one before it.
 */
const stopSinceStart = (
  status: ServerStatus.Type,
  stoppedBeforeStart: Option.Option<DateTime.Utc>
): Option.Option<ServerStatus.RunStop> =>
  ServerStatus.lastStopOf(status).pipe(
    Option.filter(
      (stop) =>
        !Option.exists(stoppedBeforeStart, (stoppedAt) =>
          DateTime.Equivalence(stoppedAt, stop.stoppedAt)
        )
    )
  )

/**
 * Where the wait for the server whose status is `status` stands, its latest
 * run having stopped at `stoppedBeforeStart` when the wait began.
 *
 * @remarks
 * The wait gives up once waiting can't help: the server's run stopped with an
 * error since the start (a server retrying after one shows that stop while it
 * waits to start again), its certificate order is failing, its certificate is
 * from a CA browsers don't trust, or it can't be reached through its relay
 * while its certificate is valid. Until its certificate is valid, an
 * unreachable server is still getting one, and the wait goes on.
 */
const waitOutcomeOf = (
  status: ServerStatus.Type,
  stoppedBeforeStart: Option.Option<DateTime.Utc>
): WaitOutcome => {
  const stop = stopSinceStart(status, stoppedBeforeStart)
  const stopError = stop.pipe(Option.flatMap((since) => since.error))
  if (Option.isSome(stopError)) {
    return { kind: 'gaveUp', failure: `The server stopped with an error: ${stopError.value}` }
  }
  if (status.certificate.status === 'orderFailing') {
    return { kind: 'gaveUp', failure: "Ordering the server's certificate is failing." }
  }
  const refusal = LaunchError.statusRefusalOf(status)
  if (Option.isNone(refusal)) return { kind: 'launchable' }
  const refused = refusal.value
  if (refused === 'untrustedCertificate') {
    return { kind: 'gaveUp', failure: REFUSAL_REASON.untrustedCertificate }
  }
  if (refused === 'unreachable') {
    // Until its certificate is valid, the server is still getting one.
    return Option.isNone(LaunchError.certificateRefusalOf(status.certificate))
      ? { kind: 'gaveUp', failure: unreachableReason(status) }
      : { kind: 'waiting', reason: unreachableReason(status) }
  }
  if (refused !== 'serverNotRunning') return { kind: 'waiting', reason: REFUSAL_REASON[refused] }
  if (status.runState === 'starting') return { kind: 'waiting', reason: 'The server is starting.' }
  return {
    kind: 'waiting',
    reason: stop.pipe(
      Option.map(lastStopText),
      Option.getOrElse(() => "The server hasn't started yet.")
    ),
  }
}

export { REFUSAL_REASON, waitOutcomeOf }
export type { WaitOutcome }

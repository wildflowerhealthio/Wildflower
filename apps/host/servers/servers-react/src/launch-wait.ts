import { LaunchError, ServerStatus } from '@wildflowerhealthio/servers-core-js'
import { DateTime, Duration, Option } from 'effect'

/**
 * How long a started server may stay unreachable through its relay while
 * its certificate is valid before the wait gives up. The host probes only
 * once the tunnel is connected, first after 400 ms and then after twice the
 * last wait, so a few seconds span the first few probes: a just-connected
 * tunnel whose first probe fails gets a couple more before the wait gives up.
 */
const UNREACHABLE_GRACE = Duration.seconds(5)

/**
 * The refusals the server's status already shows, beside Launch: its relay
 * refused its tunnel, or it hasn't been reached or can't be reached through
 * its relay. Launch is disabled for them without a reason of its own.
 */
type StatusShownRefusal = Extract<
  LaunchError.StatusRefusalKind,
  'tokenRejected' | 'tunnelUnknown' | 'notYetProbed' | 'unreachable'
>

/** Whether the server's status already shows `refusal`. */
const isStatusShownRefusal = (
  refusal: LaunchError.StatusRefusalKind
): refusal is StatusShownRefusal =>
  refusal === 'tokenRejected' ||
  refusal === 'tunnelUnknown' ||
  refusal === 'notYetProbed' ||
  refusal === 'unreachable'

/**
 * Why a running server can't be launched yet, for each refusal the host
 * answers from its status that the status doesn't show: those of its
 * certificate.
 */
const REFUSAL_REASON: Readonly<
  Record<Exclude<LaunchError.StatusRefusalKind, 'serverNotRunning' | StatusShownRefusal>, string>
> = {
  noValidCertificate: 'The server has no valid certificate yet.',
  untrustedCertificate:
    "The server's certificate is from Let's Encrypt's staging CA, which browsers don't trust.",
}

/**
 * Where the wait for a started server stands, from its status: it can be
 * launched; it can't yet, and why, unless its status shows why; or it won't
 * be, and the failure, unless its status or Launch shows why.
 */
type WaitOutcome =
  | { readonly kind: 'launchable' }
  | { readonly kind: 'waiting'; readonly reason: Option.Option<string> }
  | { readonly kind: 'gaveUp'; readonly failure: Option.Option<string> }

/** A wait that gave up. */
type GaveUp = Extract<WaitOutcome, { readonly kind: 'gaveUp' }>

/**
 * Whether the server whose status is `status` can't be reached through its
 * relay while its certificate is valid and from a CA browsers trust. Until
 * its certificate is valid, an unreachable server is still getting one.
 */
const isUnreachableWithValidCertificate = (status: ServerStatus.Type): boolean =>
  Option.contains(LaunchError.statusRefusalOf(status), 'unreachable') &&
  Option.isNone(LaunchError.certificateRefusalOf(status.certificate))

/**
 * When the wait's server, whose status is now `status`, has been unreachable
 * with a valid certificate since, without a break: `unreachableSince` while
 * it still is, `now` once it first is, and none once it isn't.
 */
const unreachableSinceOf = (
  status: ServerStatus.Type,
  unreachableSince: Option.Option<DateTime.Utc>,
  now: DateTime.Utc
): Option.Option<DateTime.Utc> =>
  isUnreachableWithValidCertificate(status)
    ? Option.orElse(unreachableSince, () => Option.some(now))
    : Option.none()

/**
 * When the unreachable grace of a server unreachable with a valid
 * certificate since `unreachableSince` ends: {@link UNREACHABLE_GRACE} later.
 */
const unreachableGraceEndOf = (
  unreachableSince: Option.Option<DateTime.Utc>
): Option.Option<DateTime.Utc> =>
  Option.map(unreachableSince, DateTime.addDuration(UNREACHABLE_GRACE))

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

/** A wait that gave up with `failure`. */
const gaveUp = (failure: Option.Option<string>): Option.Option<GaveUp> =>
  Option.some({ kind: 'gaveUp', failure })

/**
 * The wait's end once waiting for the server whose status is `status`, since
 * `confirmedAt`, can't help, with the failure to show when it says more than
 * the status and Launch do; none while waiting still can.
 *
 * @remarks
 * Waiting can't help once:
 * - its run stopped with an error during the wait, which the server's status
 *   shows (a server retrying after one shows that stop while it waits to
 *   start again);
 * - its relay refused its tunnel, which then stops dialing, and which its
 *   status shows;
 * - its certificate order is failing, which the failure says;
 * - its certificate is from a CA browsers don't trust, which Launch's
 *   reason says once the wait has ended;
 * - it is still unreachable through its relay with a valid certificate once
 *   `unreachableGraceHasPassed`, which its status shows.
 */
const gaveUpOf = (
  status: ServerStatus.Type,
  confirmedAt: DateTime.Utc,
  unreachableGraceHasPassed: boolean
): Option.Option<GaveUp> => {
  const stoppedWithError = stopDuringWait(status, confirmedAt).pipe(
    Option.exists((stop) => Option.isSome(stop.error))
  )
  const refusal = Option.getOrNull(LaunchError.statusRefusalOf(status))
  if (stoppedWithError || refusal === 'tokenRejected' || refusal === 'tunnelUnknown') {
    return gaveUp(Option.none())
  }
  if (status.certificate.status === 'orderFailing') {
    return gaveUp(Option.some("Ordering the server's certificate is failing."))
  }
  if (
    refusal === 'untrustedCertificate' ||
    (unreachableGraceHasPassed && isUnreachableWithValidCertificate(status))
  ) {
    return gaveUp(Option.none())
  }
  return Option.none()
}

/**
 * Why the server whose status is `status` can't be launched yet, its wait
 * having begun at `confirmedAt`, when its status doesn't show why: its
 * certificate's refusal, or that a stopped server hasn't started yet. None
 * while it is starting, how its run stopped during the wait, and the
 * refusals its status shows, all of which the status says.
 */
const waitingReasonOf = (
  refusal: LaunchError.StatusRefusalKind,
  status: ServerStatus.Type,
  confirmedAt: DateTime.Utc
): Option.Option<string> => {
  if (isStatusShownRefusal(refusal)) return Option.none()
  if (refusal !== 'serverNotRunning') return Option.some(REFUSAL_REASON[refusal])
  if (status.runState === 'starting' || Option.isSome(stopDuringWait(status, confirmedAt))) {
    return Option.none()
  }
  return Option.some("The server hasn't started yet.")
}

/**
 * Where the wait for the server whose status is `status`, begun at
 * `confirmedAt`, stands: it gives up once waiting can't help (`gaveUpOf`),
 * waits while the server can't be launched yet (`waitingReasonOf`), and is
 * otherwise launchable.
 */
const waitOutcomeOf = (
  status: ServerStatus.Type,
  confirmedAt: DateTime.Utc,
  unreachableGraceHasPassed: boolean
): WaitOutcome =>
  gaveUpOf(status, confirmedAt, unreachableGraceHasPassed).pipe(
    Option.orElse((): Option.Option<WaitOutcome> =>
      LaunchError.statusRefusalOf(status).pipe(
        Option.map((refusal): WaitOutcome => ({
          kind: 'waiting',
          reason: waitingReasonOf(refusal, status, confirmedAt),
        }))
      )
    ),
    Option.getOrElse((): WaitOutcome => ({ kind: 'launchable' }))
  )

export {
  isStatusShownRefusal,
  REFUSAL_REASON,
  unreachableGraceEndOf,
  unreachableSinceOf,
  waitOutcomeOf,
}
export type { StatusShownRefusal, WaitOutcome }

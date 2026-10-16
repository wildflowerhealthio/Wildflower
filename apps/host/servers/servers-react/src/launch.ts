import {
  type HostCommandError,
  LaunchError,
  type ListedServer,
  RunPolicy,
} from '@wildflowerhealthio/servers-core-js'
import { DateTime, Option } from 'effect'
import { useEffect, useState } from 'react'

import { failureText } from './failure-text.ts'
import { isStatusShownRefusal, REFUSAL_REASON, waitOutcomeOf } from './launch-wait.ts'
import { useLaunchServer, useSetServerRunPolicy } from './queries.ts'
import { usePendingLaunches, useRunHostCommand } from './router-context.ts'
import { useStartAndLaunch } from './start-and-launch.ts'
import { useHasPassed } from './use-has-passed.ts'
import { useOnline } from './use-online.ts'

/** Why Launch is disabled while the webview is offline. */
const OFFLINE_REASON = 'Apps open from the web, so launching needs a connection.'

/**
 * Why Launch is disabled for a server that isn't running while its policy
 * wants it running; none while it is starting, which its status says.
 */
const notRunningReason = (server: ListedServer.Type): Option.Option<string> =>
  server.status.runState === 'starting'
    ? Option.none()
    : Option.some("The server isn't running yet. It starts again on its own.")

/** A server's Launch: where it stands, and what it can do. */
interface Launch {
  /**
   * Why Launch is disabled, or what a start-and-launch waits on, when the
   * server's status doesn't say.
   */
  readonly reason: Option.Option<string>
  /** Whether a start-and-launch is under way, so Launch shows Starting… with Cancel. */
  readonly starting: boolean
  /** Whether Launch is disabled for where the server or the webview stands. */
  readonly disabled: boolean
  /** Whether a launch is in flight. */
  readonly isLaunching: boolean
  /** Launches, or asks to start a server that isn't running first. */
  readonly launch: () => void
  /** Cancels the start-and-launch under way. */
  readonly cancelWait: () => void
  /** Whether "Start server and launch?" is open. */
  readonly confirmingStart: boolean
  /** Whether the start "Start and launch" asked for is being set. */
  readonly isSettingStart: boolean
  /** Starts the server, unless its policy became active meanwhile, then waits to launch it. */
  readonly confirmStart: () => void
  /** Closes "Start server and launch?" without starting anything. */
  readonly cancelStart: () => void
}

/** What {@link useLaunch} reports to the caller showing its failures. */
interface LaunchReports {
  /** Called as a launch starts, when Launch is pressed. */
  readonly onActionStart: () => void
  /** Called with the text of a launch's failure. */
  readonly onError: (failure: string) => void
}

/**
 * A server's Launch: opens its launcher through `server_launch`, or says why
 * it can't when the server's status around it doesn't (`reason`).
 *
 * @remarks
 * - Offline, it is disabled and says so: the launcher is a web page.
 * - For a server that isn't running and whose run policy is `off` or an
 *   `until` that has ended, it asks "Start server and launch?". Confirming
 *   sets the policy to `whileOpen` (unless it has become active meanwhile),
 *   then it shows "Starting…", with Cancel, and why the server can't be
 *   launched yet when its status doesn't say, until the server's status
 *   (kept current by `server-status` events) is launchable, and launches it
 *   once. The wait gives up once waiting can't help (see `waitOutcomeOf`),
 *   showing its failure when it has one, and Launch is back. The wait is in
 *   the router context's `pendingLaunches`, driven by `useStartAndLaunch`,
 *   so it carries on while Edit has the server's page open, and Launch shows
 *   where it stands, or how it ended, on coming back.
 * - For a server waiting to start again while its policy still wants it
 *   running, it is disabled and says so; while such a server is starting,
 *   its status says so: launching never changes an active policy or extends
 *   an `until`.
 * - For a running server whose certificate the host would refuse (none
 *   valid, or one browsers don't trust), it is disabled and says why.
 * - For a running server the host would refuse for what its status shows
 *   (its relay refused its tunnel, or it hasn't been or can't be reached),
 *   it is disabled without a reason of its own, for the caller to describe
 *   by the status.
 * - Otherwise it launches.
 *
 * It reports each launch's start, as Launch is pressed, to `onActionStart`,
 * and its failure to `onError`: the host's refusal of the launch or of the
 * start, or why the wait gave up, which the wait in `pendingLaunches` keeps,
 * so Launch reports it again wherever it next shows. The host refuses at
 * once whenever a server isn't launchable; waiting for a started server
 * happens here.
 */
const useLaunch = (
  server: ListedServer.Type,
  { onActionStart, onError }: LaunchReports
): Launch => {
  const runHostCommand = useRunHostCommand()
  const online = useOnline()
  const pendingLaunches = usePendingLaunches()
  const launch = useLaunchServer(runHostCommand)
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const [confirmingStart, setConfirmingStart] = useState(false)
  const { pending, unreachableGraceHasPassed } = useStartAndLaunch(server)
  const policyHasEnded = useHasPassed(RunPolicy.deadlineOf(server.runPolicy))
  const policyIsInactive = server.runPolicy.kind === 'off' || policyHasEnded
  const refusal = Option.getOrNull(LaunchError.statusRefusalOf(server.status))
  const { domain } = server

  const starting = Option.exists(pending, ({ kind }) => kind !== 'failed')
  const waitingReason = pending.pipe(
    Option.flatMap((launching) => {
      if (launching.kind !== 'waiting') return Option.none()
      const outcome = waitOutcomeOf(server.status, launching.confirmedAt, unreachableGraceHasPassed)
      return outcome.kind === 'waiting' ? outcome.reason : Option.none()
    })
  )
  const reason = ((): Option.Option<string> => {
    if (!online) return Option.some(OFFLINE_REASON)
    if (starting) return waitingReason
    if (refusal === null || isStatusShownRefusal(refusal)) return Option.none()
    if (refusal !== 'serverNotRunning') return Option.some(REFUSAL_REASON[refusal])
    return policyIsInactive ? Option.none() : notRunningReason(server)
  })()
  // Launch asks to start a server that isn't running under an inactive policy.
  const refused = refusal !== null && !(refusal === 'serverNotRunning' && policyIsInactive)
  const reportFailure = (error: HostCommandError): void => {
    onError(failureText(error))
  }
  /** Wait for the server to start, from "Start and launch" confirmed at `confirmedAt`. */
  const waitForStart = (confirmedAt: DateTime.Utc): void => {
    setConfirmingStart(false)
    pendingLaunches.set(
      domain,
      Option.some({ kind: 'waiting', confirmedAt, unreachableSince: Option.none() })
    )
  }
  // The store's own object, which changes only when the launch does.
  const pendingLaunch = Option.getOrUndefined(pending)
  useEffect(() => {
    if (pendingLaunch?.kind === 'failed') onError(pendingLaunch.failure)
  }, [pendingLaunch, onError])
  return {
    reason,
    starting,
    disabled: starting || !online || refused,
    isLaunching: launch.isPending,
    launch: () => {
      onActionStart()
      pendingLaunches.set(domain, Option.none())
      if (refusal === 'serverNotRunning') {
        setConfirmingStart(true)
        return
      }
      launch.mutate({ domain }, { onError: reportFailure })
    },
    cancelWait: () => {
      pendingLaunches.set(domain, Option.none())
    },
    confirmingStart,
    isSettingStart: setRunPolicy.isPending,
    confirmStart: () => {
      const confirmedAt = DateTime.unsafeNow()
      // The policy may have changed since the question was asked: an
      // active one already starts the server, and is left as it is.
      if (!policyIsInactive) {
        waitForStart(confirmedAt)
        return
      }
      setRunPolicy.mutate(
        { domain, choice: { kind: 'whileOpen' } },
        {
          onSuccess: () => {
            waitForStart(confirmedAt)
          },
          onError: (error) => {
            setConfirmingStart(false)
            reportFailure(error)
          },
        }
      )
    },
    cancelStart: () => {
      setConfirmingStart(false)
    },
  }
}

export { useLaunch, type Launch, type LaunchReports }

import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ConfirmDialog } from '@wildflowerhealthio/react-tundraish'
import {
  type HostCommandError,
  LaunchError,
  type ListedServer,
  RunPolicy,
} from '@wildflowerhealthio/servers-core-js'
import { DateTime, Option } from 'effect'
import { type JSX, useEffect, useId, useState } from 'react'

import { failureText } from './failure-text.ts'
import { isStatusShownRefusal, REFUSAL_REASON, waitOutcomeOf } from './launch-wait.ts'
import { useLaunchServer, useSetServerRunPolicy } from './queries.ts'
import { type RunHostCommand, usePendingLaunches } from './router-context.ts'
import { useStartAndLaunch } from './start-and-launch.ts'
import { useHasPassed } from './use-has-passed.ts'
import { useOnline } from './use-online.ts'
import styles from './launch-button.module.css'

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

/**
 * A server's Launch: opens its launcher through `server_launch`, or says why
 * it can't when the server's status around it doesn't.
 *
 * @remarks
 * - Offline, it is disabled and says so: the launcher is a web page.
 * - For a server that isn't running and whose run policy is `off` or an
 *   `until` that has ended, it asks "Start server and launch?". Confirming
 *   sets the policy to `whileOpen` (unless it has become active meanwhile),
 *   then it shows "Starting…", with Cancel, under why the server can't be
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
 *   it is disabled without a reason of its own, and described by
 *   `statusDescriptionId`'s element.
 * - Otherwise it launches.
 *
 * It reports each launch's start, as Launch is pressed, to `onActionStart`,
 * and its failure to `onError`: the host's refusal of the launch or of the
 * start, or why the wait gave up, which the wait in `pendingLaunches` keeps,
 * so Launch reports it again wherever it next shows. Its parent shows the
 * failure above the row of buttons Launch sits in. Its reason sits above its
 * own buttons, never below. The host refuses at once whenever a server isn't
 * launchable; waiting for a started server happens here.
 */
const LaunchButton = ({
  server,
  runHostCommand,
  className,
  statusDescriptionId,
  onActionStart,
  onError,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
  /** Sizes the button's block in its parent's layout. */
  readonly className?: string
  /**
   * The id of the element showing the server's status, which describes
   * Launch while it is disabled for what that status shows.
   */
  readonly statusDescriptionId?: string
  /** Called as a launch starts, when Launch is pressed. */
  readonly onActionStart: () => void
  /** Called with the text of a launch's failure. */
  readonly onError: (failure: string) => void
}): JSX.Element => {
  const reasonId = useId()
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
  const disabled = starting || !online || refused
  const describedBy = reason.pipe(
    Option.as(reasonId),
    Option.orElse(() => (disabled ? Option.fromNullable(statusDescriptionId) : Option.none())),
    Option.getOrUndefined
  )
  const reportFailure = (error: HostCommandError): void => {
    onError(failureText(error))
  }
  const onLaunch = (): void => {
    onActionStart()
    pendingLaunches.set(domain, Option.none())
    if (refusal === 'serverNotRunning') {
      setConfirmingStart(true)
      return
    }
    launch.mutate({ domain }, { onError: reportFailure })
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
  return (
    <div className={cn(styles['launch-button'], className)}>
      {reason.pipe(
        Option.map((text) => (
          <p
            key="reason"
            id={reasonId}
            className={`text-body-3 ${styles['launch-button__reason']}`}
          >
            {text}
          </p>
        )),
        Option.getOrNull
      )}
      <div className={styles['launch-button__buttons']}>
        {starting ? (
          <>
            <button
              type="button"
              className={`button-2 filled ${styles['launch-button__launch']}`}
              disabled
              aria-describedby={describedBy}
            >
              Starting…
            </button>
            <button
              type="button"
              className="button-2 outline"
              onClick={() => {
                pendingLaunches.set(domain, Option.none())
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`button-2 filled ${styles['launch-button__launch']}`}
            disabled={disabled || launch.isPending}
            aria-describedby={describedBy}
            onClick={onLaunch}
          >
            Launch
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmingStart}
        title="Start server and launch?"
        confirmLabel="Start and launch"
        pending={setRunPolicy.isPending}
        onConfirm={() => {
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
        }}
        onCancel={() => {
          setConfirmingStart(false)
        }}
      >
        {domain} isn't running. Starting it runs it while Wildflower is open; it launches once it
        can be reached.
      </ConfirmDialog>
    </div>
  )
}

export { LaunchButton }

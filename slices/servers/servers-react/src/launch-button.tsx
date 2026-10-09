import { useRouteContext } from '@tanstack/react-router'
import { DateTime, Effect, Either, Option } from 'effect'
import { type JSX, useEffect, useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ConfirmDialog, ErrorBanner } from 'react-tundraish'
import { LaunchError, type ListedServer, launchServer, RunPolicy } from 'servers-core'

import { failureText } from './failure-text.ts'
import {
  REFUSAL_REASON,
  unreachableGraceEndOf,
  unreachableSinceOf,
  waitOutcomeOf,
} from './launch-wait.ts'
import { type PendingLaunches, usePendingLaunch, type WaitingLaunch } from './pending-launches.ts'
import { useLaunchServer, useSetServerRunPolicy } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import { useHasPassed } from './use-has-passed.ts'
import { useOnline } from './use-online.ts'
import styles from './launch-button.module.css'

/** Why Launch is disabled while the webview is offline. */
const OFFLINE_REASON = 'Apps open from the web, so launching needs a connection.'

/** Why Launch is disabled for a server that isn't running while its policy wants it running. */
const notRunningReason = (server: ListedServer.Type): string =>
  server.status.runState === 'starting'
    ? 'The server is starting.'
    : "The server isn't running yet. It starts again on its own."

/**
 * While the server `server`'s start-and-launch is waiting, launch it once its
 * status is launchable and the webview is online, or end the wait with the
 * failure once waiting can't help (see `waitOutcomeOf`). The launch's outcome
 * ends it too, unless it was cancelled meanwhile.
 *
 * @remarks
 * It keeps the wait's `unreachableSince` current from each status, and looks
 * again when `unreachableGraceHasPassed` turns true at the end of that
 * grace: the host sends a status only when it changes, so a server still
 * unreachable sends none then.
 */
const useDriveStartAndLaunch = (
  server: ListedServer.Type,
  online: boolean,
  unreachableGraceHasPassed: boolean,
  pendingLaunches: PendingLaunches,
  runHostCommand: RunHostCommand
): void => {
  // The store's own object, which changes only when the launch does.
  const pending = Option.getOrUndefined(usePendingLaunch(pendingLaunches, server.domain))
  const { domain, status } = server
  useEffect(() => {
    if (pending?.kind !== 'waiting') return
    const unreachableSince = unreachableSinceOf(
      status,
      pending.unreachableSince,
      DateTime.unsafeNow()
    )
    if (Option.isSome(unreachableSince) !== Option.isSome(pending.unreachableSince)) {
      pendingLaunches.set(domain, Option.some({ ...pending, unreachableSince }))
      return
    }
    const outcome = waitOutcomeOf(status, pending.confirmedAt, unreachableGraceHasPassed)
    if (outcome.kind === 'gaveUp') {
      pendingLaunches.set(domain, Option.some({ kind: 'failed', failure: outcome.failure }))
      return
    }
    if (outcome.kind !== 'launchable' || !online) return
    pendingLaunches.set(domain, Option.some({ kind: 'launching' }))
    const settle = (failure: Option.Option<string>): void => {
      // A wait cancelled while it launched stays cancelled.
      if (pendingLaunches.snapshotOf(domain)?.kind !== 'launching') return
      pendingLaunches.set(
        domain,
        Option.map(failure, (text) => ({ kind: 'failed', failure: text }))
      )
    }
    void runHostCommand(Effect.either(launchServer({ domain }))).then(
      (launched) => {
        settle(
          Either.match(launched, {
            onLeft: (error) => Option.some(failureText(error)),
            onRight: () => Option.none(),
          })
        )
      },
      (defect: unknown) => {
        settle(Option.some(`Launching failed: ${String(defect)}`))
      }
    )
  }, [pending, status, online, domain, pendingLaunches, runHostCommand, unreachableGraceHasPassed])
}

/**
 * A server's Launch: opens its launcher through `server_launch`, or says why
 * it can't.
 *
 * @remarks
 * - Offline, it is disabled: the launcher is a web page.
 * - For a server that isn't running and whose run policy is `off` or an
 *   `until` that has ended, it asks "Start server and launch?". Confirming
 *   sets the policy to `whileOpen` (unless it has become active meanwhile),
 *   then it shows "Starting…", with Cancel, over why the server can't be
 *   launched yet, until the server's status (kept current by `server-status`
 *   events) is launchable, and launches it once. The wait gives up, showing
 *   why, once waiting can't help (see `waitOutcomeOf`), and Launch is back.
 *   The wait is in the router context's `pendingLaunches`, so it carries on
 *   when Edit opens the server's page, whose Launch shows it too.
 * - For a server that isn't running while its policy still wants it running
 *   (starting, or waiting to start again), it is disabled and says so:
 *   launching never changes an active policy or extends an `until`.
 * - For a running server the host would refuse (not yet reached, unreachable,
 *   no valid certificate, a certificate browsers don't trust), it is disabled
 *   and says why.
 * - Otherwise it launches, and shows the host's refusal when there is one.
 *
 * The host refuses at once whenever a server isn't launchable; waiting for a
 * started server happens here.
 */
const LaunchButton = ({
  server,
  runHostCommand,
  className,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
  /** Sizes the button's block in its parent's layout. */
  readonly className?: string
}): JSX.Element => {
  const reasonId = useId()
  const online = useOnline()
  const pendingLaunches = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.pendingLaunches,
  })
  const launch = useLaunchServer(runHostCommand)
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const [confirmingStart, setConfirmingStart] = useState(false)
  const pending = usePendingLaunch(pendingLaunches, server.domain)
  const unreachableGraceHasPassed = useHasPassed(
    pending.pipe(
      Option.filter((launching): launching is WaitingLaunch => launching.kind === 'waiting'),
      Option.flatMap(({ unreachableSince }) => unreachableGraceEndOf(unreachableSince))
    )
  )
  useDriveStartAndLaunch(server, online, unreachableGraceHasPassed, pendingLaunches, runHostCommand)
  const policyHasEnded = useHasPassed(RunPolicy.deadlineOf(server.runPolicy))
  const policyIsInactive = server.runPolicy.kind === 'off' || policyHasEnded
  const refusal = Option.getOrNull(LaunchError.statusRefusalOf(server.status))
  const { domain } = server

  const starting = Option.exists(pending, ({ kind }) => kind !== 'failed')
  const waitingReason = pending.pipe(
    Option.flatMap((launching) => {
      if (launching.kind !== 'waiting') return Option.none()
      const outcome = waitOutcomeOf(server.status, launching.confirmedAt, unreachableGraceHasPassed)
      return outcome.kind === 'waiting' ? Option.some(outcome.reason) : Option.none()
    })
  )
  const reason = ((): Option.Option<string> => {
    if (!online) return Option.some(OFFLINE_REASON)
    if (starting) return waitingReason
    if (refusal === null) return Option.none()
    if (refusal !== 'serverNotRunning') return Option.some(REFUSAL_REASON[refusal])
    return policyIsInactive ? Option.none() : Option.some(notRunningReason(server))
  })()
  const onLaunch = (): void => {
    // A new attempt clears the previous one's failure.
    setRunPolicy.reset()
    pendingLaunches.set(domain, Option.none())
    if (refusal === 'serverNotRunning') {
      setConfirmingStart(true)
      return
    }
    launch.mutate({ domain })
  }
  /** Wait for the server to start, from "Start and launch" confirmed at `confirmedAt`. */
  const waitForStart = (confirmedAt: DateTime.Utc): void => {
    launch.reset()
    setConfirmingStart(false)
    pendingLaunches.set(
      domain,
      Option.some({ kind: 'waiting', confirmedAt, unreachableSince: Option.none() })
    )
  }
  const pendingFailure = pending.pipe(
    Option.flatMap((launching) =>
      launching.kind === 'failed' ? Option.some(launching.failure) : Option.none()
    )
  )
  const mutationError = launch.error ?? setRunPolicy.error
  const error =
    mutationError === null ? Option.getOrNull(pendingFailure) : failureText(mutationError)
  return (
    <div className={cn(styles['launch-button'], className)}>
      <div className={styles['launch-button__buttons']}>
        {starting ? (
          <>
            <button
              type="button"
              className={`button-2 filled ${styles['launch-button__launch']}`}
              disabled
              aria-describedby={reason.pipe(Option.as(reasonId), Option.getOrUndefined)}
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
            disabled={Option.isSome(reason) || launch.isPending}
            aria-describedby={reason.pipe(Option.as(reasonId), Option.getOrUndefined)}
            onClick={onLaunch}
          >
            Launch
          </button>
        )}
      </div>
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
      <ErrorBanner error={error} />
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
              onError: () => {
                setConfirmingStart(false)
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

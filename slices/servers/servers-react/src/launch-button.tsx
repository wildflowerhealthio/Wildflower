import { Option } from 'effect'
import { type JSX, useEffect, useId, useRef, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ConfirmDialog, ErrorBanner } from 'react-tundraish'
import { LaunchError, type ListedServer, RunPolicy } from 'servers-core'

import { failureText } from './failure-text.ts'
import { useLaunchServer, useSetServerRunPolicy } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import { useHasPassed } from './use-has-passed.ts'
import { useOnline } from './use-online.ts'
import styles from './launch-button.module.css'

/** Why Launch is disabled while the webview is offline. */
const OFFLINE_REASON = 'Apps open from the web, so launching needs a connection.'

/**
 * Why Launch is disabled for a server the host would refuse to launch, for
 * each refusal but `serverNotRunning`, which {@link notRunningReason} words.
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

/** Why Launch is disabled for a server that isn't running while its policy wants it running. */
const notRunningReason = (server: ListedServer.Type): string =>
  server.status.runState === 'starting'
    ? 'The server is starting.'
    : "The server isn't running yet. It starts again on its own."

/**
 * Where a launch stands: nothing under way, asking whether to start the
 * server, or waiting for the started server to become launchable.
 */
type LaunchPhase = 'idle' | 'confirmingStart' | 'starting'

/**
 * A server's Launch: opens its launcher through `server_launch`, or says why
 * it can't.
 *
 * @remarks
 * - Offline, it is disabled: the launcher is a web page.
 * - For a server that isn't running and whose run policy is `off` or an
 *   `until` that has ended, it asks "Start server and launch?". Confirming
 *   sets the policy to `whileOpen` (unless it has become active meanwhile),
 *   then it shows "Starting…", with Cancel, until the server's status (kept
 *   current by `server-status` events) is launchable, and launches it once.
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
  const launch = useLaunchServer(runHostCommand)
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const [phase, setPhase] = useState<LaunchPhase>('idle')
  const policyHasEnded = useHasPassed(RunPolicy.deadlineOf(server.runPolicy))
  const policyIsInactive = server.runPolicy.kind === 'off' || policyHasEnded
  const refusal = Option.getOrNull(LaunchError.statusRefusalOf(server.status))
  const { domain } = server
  const { mutate: launchServer } = launch

  // A started server is launched once, as soon as its status is launchable;
  // the wait ends when that launch settles.
  const launchedForStart = useRef(false)
  useEffect(() => {
    if (phase !== 'starting' || refusal !== null || !online || launchedForStart.current) return
    launchedForStart.current = true
    launchServer(
      { domain },
      {
        onSettled: () => {
          setPhase('idle')
        },
      }
    )
  }, [phase, refusal, online, domain, launchServer])

  const reason = ((): Option.Option<string> => {
    if (!online) return Option.some(OFFLINE_REASON)
    if (phase === 'starting' || refusal === null) return Option.none()
    if (refusal !== 'serverNotRunning') return Option.some(REFUSAL_REASON[refusal])
    return policyIsInactive ? Option.none() : Option.some(notRunningReason(server))
  })()
  const onLaunch = (): void => {
    // A new attempt clears the previous one's failure.
    setRunPolicy.reset()
    if (refusal === 'serverNotRunning') {
      setPhase('confirmingStart')
      return
    }
    launch.mutate({ domain })
  }
  const waitForStart = (): void => {
    launch.reset()
    launchedForStart.current = false
    setPhase('starting')
  }
  const error = launch.error ?? setRunPolicy.error
  return (
    <div className={cn(styles['launch-button'], className)}>
      <div className={styles['launch-button__buttons']}>
        {phase === 'starting' ? (
          <>
            <button
              type="button"
              className={`button-2 filled ${styles['launch-button__launch']}`}
              disabled
            >
              Starting…
            </button>
            <button
              type="button"
              className="button-2 outline"
              onClick={() => {
                setPhase('idle')
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
      <ErrorBanner error={error === null ? null : failureText(error)} />
      <ConfirmDialog
        open={phase === 'confirmingStart'}
        title="Start server and launch?"
        confirmLabel="Start and launch"
        pending={setRunPolicy.isPending}
        onConfirm={() => {
          // The policy may have changed since the question was asked: an
          // active one already starts the server, and is left as it is.
          if (!policyIsInactive) {
            waitForStart()
            return
          }
          setRunPolicy.mutate(
            { domain, choice: { kind: 'whileOpen' } },
            {
              onSuccess: waitForStart,
              onError: () => {
                setPhase('idle')
              },
            }
          )
        }}
        onCancel={() => {
          // The dialog reports its own closing as a cancel too, as when a
          // confirmed start moves on to `starting`: only a pending question
          // is cancelled.
          setPhase((current) => (current === 'confirmingStart' ? 'idle' : current))
        }}
      >
        {domain} isn't running. Starting it runs it while Wildflower is open; it launches once it
        can be reached.
      </ConfirmDialog>
    </div>
  )
}

export { LaunchButton }

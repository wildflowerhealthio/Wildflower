import { DateTime, Option, pipe } from 'effect'
import { type ChangeEvent, type JSX, useState } from 'react'
import { ConfirmDialog, ErrorBanner, StatusBadge, type StatusTone } from 'react-tundraish'
import {
  HostCommandFailed,
  type HostCommandError,
  type ListedServer,
  RunPolicy,
  type RunPolicyChoice,
  ServerStatus,
} from 'servers-core'

import { useRemoveServer, useSetServerRunPolicy } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import styles from './server-row.module.css'

/** An instant as the base shows it, in the device's locale and time zone. */
const formatInstant = (instant: DateTime.Utc): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    DateTime.toDate(instant)
  )

/** The run-policy choices the control offers, by its option value. */
const RUN_POLICY_CHOICES: ReadonlyArray<{
  readonly value: string
  readonly label: string
  readonly choice: RunPolicyChoice.Type
}> = [
  { value: 'off', label: 'Off', choice: { kind: 'off' } },
  { value: 'whileOpen', label: 'While open', choice: { kind: 'whileOpen' } },
  { value: 'for-15m', label: 'For 15 minutes', choice: { kind: 'for', seconds: 15 * 60 } },
  { value: 'for-1h', label: 'For 1 hour', choice: { kind: 'for', seconds: 60 * 60 } },
  { value: 'for-8h', label: 'For 8 hours', choice: { kind: 'for', seconds: 8 * 60 * 60 } },
  { value: 'always', label: 'Always', choice: { kind: 'always' } },
]

/** The control's value for a stored `until` policy, which is no choice of its own. */
const UNTIL_VALUE = 'until'

/** The control's value for `policy`: its own kind, or {@link UNTIL_VALUE}. */
const runPolicyValue = (policy: RunPolicy.Type): string =>
  policy.kind === 'until' ? UNTIL_VALUE : policy.kind

/** What a stored `until` says: when it ends, or that it has ended. */
const deadlineText = (policy: RunPolicy.Type, now: DateTime.Utc): Option.Option<string> =>
  RunPolicy.deadlineOf(policy).pipe(
    Option.map((at) =>
      RunPolicy.hasEndedAt(policy, now)
        ? `Ended at ${formatInstant(at)}`
        : `Until ${formatInstant(at)}`
    )
  )

/** A badge's tone and label. */
interface Badge {
  readonly tone: StatusTone
  readonly label: string
}

/** The run-state badge: a stopped server whose latest run failed is in danger. */
const runStateBadge = (status: ServerStatus.Type): Badge => {
  if (status.runState === 'starting') return { tone: 'info', label: 'Starting' }
  if (status.runState === 'running') return { tone: 'success', label: 'Running' }
  const failed = ServerStatus.lastStopOf(status).pipe(
    Option.exists((stop) => Option.isSome(stop.error))
  )
  return { tone: failed ? 'danger' : 'neutral', label: 'Stopped' }
}

/** The health badge of a server that answered `/health`, by the status it answered with. */
const REACHABLE_BADGE: Readonly<Record<'pass' | 'warn' | 'fail', Badge>> = {
  pass: { tone: 'success', label: 'Reachable' },
  warn: { tone: 'warning', label: 'Reachable, degraded' },
  fail: { tone: 'danger', label: 'Reachable, failing its health checks' },
}

/** The health badge. */
const healthBadge = (health: ServerStatus.Health): Badge =>
  health.kind === 'reachable'
    ? REACHABLE_BADGE[health.status]
    : { tone: 'warning', label: 'Not reachable yet' }

/** Why a run stopped, as a sentence, for every reason but a failure. */
const STOP_REASON_TEXT: Readonly<
  Record<Exclude<ServerStatus.RunStop['reason'], 'endedOnItsOwn'>, string>
> = {
  keepAliveRevoked: 'The system ended its time in the background.',
  policyInactive: 'It stopped as its run policy ended.',
  replaced: 'It stopped to start again with its new settings.',
  removed: 'It was removed.',
  stoppedForRestart: 'It stopped to start again.',
}

/** Why the server's latest run stopped, as a sentence. */
const lastStopText = (stop: ServerStatus.RunStop): string =>
  stop.reason === 'endedOnItsOwn'
    ? stop.error.pipe(
        Option.map((error) => `It stopped with an error: ${error}`),
        Option.getOrElse(() => 'It stopped on its own.')
      )
    : STOP_REASON_TEXT[stop.reason]

/** The sentence a failed host command shows: the host's own message, when it ran. */
const failureText = (error: HostCommandError): string =>
  error instanceof HostCommandFailed
    ? error.refusal.pipe(
        Option.map((refusal) => refusal.message),
        Option.getOrElse(() => error.message)
      )
    : error.message

/**
 * One server in the base's list: its domain, its run state and health, why
 * its latest run stopped, when it runs, and its removal, behind a confirm.
 */
const ServerRow = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const removeServer = useRemoveServer(runHostCommand)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const runState = runStateBadge(server.status)
  const now = DateTime.unsafeNow()
  const failure = pipe(
    Option.fromNullable(setRunPolicy.error),
    Option.orElse(() => Option.fromNullable(removeServer.error))
  )
  const onRunPolicyChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const picked = RUN_POLICY_CHOICES.find((option) => option.value === event.target.value)
    if (picked === undefined) return
    setRunPolicy.mutate({ domain: server.domain, choice: picked.choice })
  }
  return (
    <li className={styles['server-row']} aria-label={server.domain}>
      <div className={styles['server-row__heading']}>
        <span className={`text-heading-4 ${styles['server-row__domain']}`}>{server.domain}</span>
        <StatusBadge tone={runState.tone}>{runState.label}</StatusBadge>
        {ServerStatus.healthOf(server.status).pipe(
          Option.map(healthBadge),
          Option.map((health) => (
            <StatusBadge key="health" tone={health.tone}>
              {health.label}
            </StatusBadge>
          )),
          Option.getOrNull
        )}
      </div>
      {ServerStatus.runningSinceOf(server.status).pipe(
        Option.map((since) => (
          <p key="running-since" className="text-body-2">
            Running since {formatInstant(since)}
          </p>
        )),
        Option.getOrNull
      )}
      {ServerStatus.lastStopOf(server.status).pipe(
        Option.map((stop) => (
          <p key="last-stop" className="text-body-2">
            {lastStopText(stop)}
          </p>
        )),
        Option.getOrNull
      )}
      <div className={styles['server-row__controls']}>
        <label className={styles['server-row__run-policy']}>
          <span className="text-body-2">Runs</span>
          <select
            value={runPolicyValue(server.runPolicy)}
            disabled={setRunPolicy.isPending}
            onChange={onRunPolicyChange}
          >
            {deadlineText(server.runPolicy, now).pipe(
              Option.map((text) => (
                <option key={UNTIL_VALUE} value={UNTIL_VALUE} disabled>
                  {text}
                </option>
              )),
              Option.getOrNull
            )}
            {RUN_POLICY_CHOICES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button-2 outline accent-red"
          onClick={() => {
            setConfirmingRemoval(true)
          }}
        >
          Remove
        </button>
      </div>
      {failure.pipe(
        Option.map((error) => <ErrorBanner key="failure" error={failureText(error)} />),
        Option.getOrNull
      )}
      <ConfirmDialog
        open={confirmingRemoval}
        title={`Remove ${server.domain}?`}
        confirmLabel="Remove"
        destructive
        pending={removeServer.isPending}
        onConfirm={() => {
          removeServer.mutate(
            { domain: server.domain },
            {
              onSettled: () => {
                setConfirmingRemoval(false)
              },
            }
          )
        }}
        onCancel={() => {
          setConfirmingRemoval(false)
        }}
      >
        This stops the server and deletes it from this device, with its databases and certificates.
        It can't be undone.
      </ConfirmDialog>
    </li>
  )
}

export { ServerRow }

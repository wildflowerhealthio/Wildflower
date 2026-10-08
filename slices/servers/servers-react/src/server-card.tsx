import { Link } from '@tanstack/react-router'
import { DateTime, Option } from 'effect'
import type { ChangeEvent, JSX } from 'react'
import { ErrorBanner, type StatusTone } from 'react-tundraish'
import { type ListedServer, RunPolicy, type RunPolicyChoice, ServerStatus } from 'servers-core'

import { failureText } from './failure-text.ts'
import { useSetServerRunPolicy } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import styles from './server-card.module.css'

/** How the base shows an instant, in the device's locale and time zone. */
const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** An instant as the base shows it. */
const formatInstant = (instant: DateTime.Utc): string =>
  INSTANT_FORMAT.format(DateTime.toDate(instant))

/** The run-policy choices the control offers, by its option value. */
const RUN_POLICY_CHOICES: ReadonlyArray<{
  readonly value: string
  readonly label: string
  readonly choice: RunPolicyChoice.Type
}> = [
  { value: 'off', label: 'Off', choice: { kind: 'off' } },
  { value: 'whileOpen', label: 'While Wildflower is open', choice: { kind: 'whileOpen' } },
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

/** A server's status as the card shows it: the tone of its dot and field, and its words. */
interface StatusSummary {
  readonly tone: StatusTone
  readonly label: string
}

/** The status of a running server that answered `/health`, by the status it answered with. */
const REACHABLE_STATUS: Readonly<Record<'pass' | 'warn' | 'fail', StatusSummary>> = {
  pass: { tone: 'success', label: 'Running' },
  warn: { tone: 'warning', label: 'Running, degraded' },
  fail: { tone: 'danger', label: 'Running, failing its health checks' },
}

/** The status of a running server, by its health. */
const runningStatus = (health: ServerStatus.Health): StatusSummary =>
  health.kind === 'reachable'
    ? REACHABLE_STATUS[health.status]
    : { tone: 'warning', label: 'Running, not reachable yet' }

/**
 * The status, merged from the run state and the health: a running server is
 * a success only once it answers `/health`, and a stopped server whose
 * latest run failed is in danger.
 */
const statusSummary = (status: ServerStatus.Type): StatusSummary => {
  if (status.runState === 'starting') return { tone: 'info', label: 'Starting' }
  if (status.runState === 'running') {
    return ServerStatus.healthOf(status).pipe(
      Option.map(runningStatus),
      Option.getOrElse((): StatusSummary => ({
        tone: 'info',
        label: 'Running, checking it can be reached',
      }))
    )
  }
  const failed = ServerStatus.lastStopOf(status).pipe(
    Option.exists((stop) => Option.isSome(stop.error))
  )
  return { tone: failed ? 'danger' : 'neutral', label: 'Stopped' }
}

/** What the field says of when the server runs, for every policy but `until`. */
const RUN_POLICY_TEXT: Readonly<Record<Exclude<RunPolicy.Kind, 'until'>, string>> = {
  off: 'Off',
  whileOpen: 'On while Wildflower is open',
  always: 'Always on',
}

/**
 * What the field says of when the server runs; for a stored `until`, the
 * picker's own option says the same.
 */
const runPolicyText = (policy: RunPolicy.Type, now: DateTime.Utc): string => {
  if (policy.kind !== 'until') return RUN_POLICY_TEXT[policy.kind]
  return RunPolicy.hasEndedAt(policy, now)
    ? `Ended at ${formatInstant(policy.at)}`
    : `On until ${formatInstant(policy.at)}`
}

/** Why a run stopped, as a sentence, for every reason but a failure. */
const STOP_REASON_TEXT: Readonly<
  Record<Exclude<ServerStatus.RunStop['reason'], 'endedOnItsOwn'>, string>
> = {
  policyInactive: 'It stopped as its run policy ended.',
  replaced: 'It stopped to start again with its new settings.',
  removed: 'It was removed.',
  sessionEndedByPlatform: 'The system ended its time in the background.',
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

/**
 * One server's card in the base's list: its domain and a status dot; a
 * run-policy field that says when it runs, outlined in its status's tone,
 * over the native picker that changes it; the host's refusal of the latest
 * change; why its latest run stopped; and Launch and Edit.
 *
 * @remarks
 * The picker is disabled while a change is pending. Launch does nothing yet:
 * launching an app from the base isn't built. Edit opens the server's page,
 * `/servers/$domain`, where it is removed.
 */
const ServerCard = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const status = statusSummary(server.status)
  const now = DateTime.unsafeNow()
  const onPick = (event: ChangeEvent<HTMLSelectElement>): void => {
    const picked = RUN_POLICY_CHOICES.find((option) => option.value === event.target.value)
    if (picked === undefined) return
    setRunPolicy.mutate({ domain: server.domain, choice: picked.choice })
  }
  return (
    <li className={styles['server-card']} data-tone={status.tone} aria-label={server.domain}>
      <div className={styles['server-card__title']}>
        <span className={styles['server-card__domain']} title={server.domain}>
          {server.domain}
        </span>
        <span
          className={styles['server-card__dot']}
          role="img"
          aria-label={status.label}
          title={status.label}
        />
      </div>
      <label className={styles['server-card__run-policy']} title="Change when this server runs">
        <span className={styles['server-card__run-policy-text']}>
          {runPolicyText(server.runPolicy, now)}
        </span>
        <span className={styles['server-card__chevron']} aria-hidden="true" />
        <select
          className={styles['server-card__picker']}
          aria-label={`When ${server.domain} runs`}
          value={runPolicyValue(server.runPolicy)}
          disabled={setRunPolicy.isPending}
          onChange={onPick}
        >
          {server.runPolicy.kind === 'until' ? (
            <option value={UNTIL_VALUE} disabled>
              {runPolicyText(server.runPolicy, now)}
            </option>
          ) : null}
          {RUN_POLICY_CHOICES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <ErrorBanner error={setRunPolicy.error === null ? null : failureText(setRunPolicy.error)} />
      {ServerStatus.lastStopOf(server.status).pipe(
        Option.map((stop) => (
          <p key="last-stop" className={`text-body-3 ${styles['server-card__last-stop']}`}>
            {lastStopText(stop)}
          </p>
        )),
        Option.getOrNull
      )}
      <div className={styles['server-card__actions']}>
        <button type="button" className={`button-2 filled ${styles['server-card__action']}`}>
          Launch
        </button>
        <Link
          to="/servers/$domain"
          params={{ domain: server.domain }}
          className={`button button-2 outline ${styles['server-card__action']}`}
        >
          Edit
        </Link>
      </div>
    </li>
  )
}

export { ServerCard }

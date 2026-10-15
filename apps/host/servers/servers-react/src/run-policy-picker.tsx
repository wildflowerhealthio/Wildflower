import { useRouteContext } from '@tanstack/react-router'
import { ErrorBanner, type StatusTone } from '@wildflowerhealthio/react-tundraish'
import {
  HostPlatform,
  type ListedServer,
  RunPolicy,
  type RunPolicyChoice,
} from '@wildflowerhealthio/servers-core-js'
import { DateTime, Duration } from 'effect'
import type { ChangeEvent, JSX } from 'react'

import { failureText } from './failure-text.ts'
import { useSetServerRunPolicy } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import { formatInstant } from './server-status-text.ts'
import { useNow } from './use-now.ts'
import styles from './run-policy-picker.module.css'

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

/** What the field says of when the server runs, for every policy but `until`. */
const RUN_POLICY_TEXT: Readonly<Record<Exclude<RunPolicy.Kind, 'until'>, string>> = {
  off: 'Off',
  whileOpen: 'On while Wildflower is open',
  always: 'Always on',
}

/**
 * The time from `now` to `at`, which is ahead of it, rounded up: in minutes
 * under an hour, so never "0 min", and in whole hours from an hour.
 */
const remainingText = (now: DateTime.Utc, at: DateTime.Utc): string => {
  const remaining = DateTime.distanceDuration(now, at)
  const minutes = Math.ceil(Duration.toMinutes(remaining))
  return minutes < 60 ? `${minutes} min` : `${Math.ceil(Duration.toHours(remaining))} h`
}

/**
 * What the field says of when the server runs; for a stored `until`, the
 * picker's own option says the same.
 */
const runPolicyText = (policy: RunPolicy.Type, now: DateTime.Utc): string => {
  if (policy.kind !== 'until') return RUN_POLICY_TEXT[policy.kind]
  return RunPolicy.hasEndedAt(policy, now)
    ? `Ended at ${formatInstant(policy.at)}`
    : `On for ${remainingText(now, policy.at)} — until ${formatInstant(policy.at)}`
}

/**
 * Whether `policy` asks the server to run with the app closed: `always`, or
 * an `until` that hasn't ended.
 */
const asksToRunWithAppClosed = (policy: RunPolicy.Type, now: DateTime.Utc): boolean =>
  policy.kind === 'always' || (policy.kind === 'until' && !RunPolicy.hasEndedAt(policy, now))

/** What a phone does to a server whose policy asks it to run with the app closed. */
const PHONE_NOTE =
  'On a phone, the server keeps running only while Wildflower is open, plus a short grace after you leave.'

/**
 * A server's run-policy field: on a phone, while the policy asks the server
 * to run with the app closed, a note above it that the phone stops it soon
 * after the app is left; what it says of when the server runs, outlined in
 * `tone`, over the native picker that changes it at once; and the host's
 * refusal of the latest change.
 *
 * @remarks
 * A live `until` says the time left, rounded up, and its deadline, and reads
 * as ended once the deadline passes, with no change of policy: the field's
 * clock ticks each minute, on the deadline's minutes. The picker is disabled
 * while a change is pending. A refused change puts the previous policy back
 * (see `useSetServerRunPolicy`).
 */
const RunPolicyPicker = ({
  server,
  tone,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  /**
   * The server's status tone, which outlines the field; a neutral one keeps
   * the input's own border.
   */
  readonly tone: StatusTone
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const platform = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.platform,
  })
  const now = useNow(Duration.minutes(1), RunPolicy.deadlineOf(server.runPolicy))
  const onPick = (event: ChangeEvent<HTMLSelectElement>): void => {
    const picked = RUN_POLICY_CHOICES.find((option) => option.value === event.target.value)
    if (picked === undefined) return
    setRunPolicy.mutate({ domain: server.domain, choice: picked.choice })
  }
  return (
    <>
      {HostPlatform.isPhone(platform) && asksToRunWithAppClosed(server.runPolicy, now) ? (
        <p className={`text-body-3 ${styles['run-policy-picker__note']}`}>{PHONE_NOTE}</p>
      ) : null}
      <label
        className={styles['run-policy-picker']}
        data-tone={tone}
        title="Change when this server runs"
      >
        <span className={styles['run-policy-picker__text']}>
          {runPolicyText(server.runPolicy, now)}
        </span>
        <span className={styles['run-policy-picker__chevron']} aria-hidden="true" />
        <select
          className={styles['run-policy-picker__select']}
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
    </>
  )
}

export { RunPolicyPicker }

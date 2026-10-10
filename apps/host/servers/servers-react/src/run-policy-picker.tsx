import { ErrorBanner, type StatusTone } from '@wildflowerhealthio/react-tundraish'
import {
  type ListedServer,
  RunPolicy,
  type RunPolicyChoice,
} from '@wildflowerhealthio/servers-core-js'
import { DateTime } from 'effect'
import type { ChangeEvent, JSX } from 'react'

import { failureText } from './failure-text.ts'
import { useSetServerRunPolicy } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import { formatInstant } from './server-status-text.ts'
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
 * What the field says of when the server runs; for a stored `until`, the
 * picker's own option says the same.
 */
const runPolicyText = (policy: RunPolicy.Type, now: DateTime.Utc): string => {
  if (policy.kind !== 'until') return RUN_POLICY_TEXT[policy.kind]
  return RunPolicy.hasEndedAt(policy, now)
    ? `Ended at ${formatInstant(policy.at)}`
    : `On until ${formatInstant(policy.at)}`
}

/**
 * A server's run-policy field: what it says of when the server runs,
 * outlined in `tone`, over the native picker that changes it at once; and
 * the host's refusal of the latest change.
 *
 * @remarks
 * The picker is disabled while a change is pending. A refused change puts
 * the previous policy back (see `useSetServerRunPolicy`).
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
  const now = DateTime.unsafeNow()
  const onPick = (event: ChangeEvent<HTMLSelectElement>): void => {
    const picked = RUN_POLICY_CHOICES.find((option) => option.value === event.target.value)
    if (picked === undefined) return
    setRunPolicy.mutate({ domain: server.domain, choice: picked.choice })
  }
  return (
    <>
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

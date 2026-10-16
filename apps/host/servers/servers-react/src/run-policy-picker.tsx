import { ErrorBanner, type StatusTone } from '@wildflowerhealthio/react-tundraish'
import {
  type HostPlatform,
  type ListedServer,
  RunPolicy,
  type RunPolicyChoice,
} from '@wildflowerhealthio/servers-core-js'
import type { DateTime } from 'effect'
import { Duration, Option } from 'effect'
import { type ChangeEvent, type JSX, useId } from 'react'

import { failureText } from './failure-text.ts'
import { useSetServerRunPolicy } from './queries.ts'
import { type RunHostCommand, useHostPlatform } from './router-context.ts'
import { runPolicyText } from './run-policy-text.ts'
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

/**
 * Whether `policy` asks the server to run with the app closed: `always`, or
 * an `until` that hasn't ended.
 */
const asksToRunWithAppClosed = (policy: RunPolicy.Type, now: DateTime.Utc): boolean =>
  policy.kind === 'always' || (policy.kind === 'until' && !RunPolicy.hasEndedAt(policy, now))

/**
 * What each phone does to a server whose policy asks it to run with the app
 * closed: Android serves for the host's 2-minute grace period after the app
 * is left; iOS for the background time it gives the app, about 30 seconds,
 * less the 5 the host keeps to stop cleanly, and again in the background
 * tasks it launches later, when it chooses. A desktop keeps it running.
 */
const PHONE_NOTES: Readonly<Partial<Record<HostPlatform.Type, string>>> = {
  android:
    'On Android, the server keeps running only while Wildflower is open, and for 2 minutes after you leave.',
  ios: 'On iOS, the server runs while Wildflower is open and for about 25 seconds after you leave; after that, only in short spells iOS allows now and then.',
}

/**
 * A server's run-policy field: on a phone, while the policy asks the server
 * to run with the app closed, a note above it, and describing its picker, of
 * how long that phone lets it run once the app is left; what it says of when the server runs, outlined in
 * `tone`, over the native picker that changes it at once; and the host's
 * refusal of the latest change.
 *
 * @remarks
 * A live `until` says the time left, rounded up, and its deadline, and reads
 * as ended once the deadline passes, with no change of policy: the field's
 * clock ticks each minute, on the deadline's minutes, until it passes. The picker is disabled
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
  const platform = useHostPlatform()
  const now = useNow(Duration.minutes(1), RunPolicy.deadlineOf(server.runPolicy))
  const noteId = useId()
  const note = Option.fromNullable(PHONE_NOTES[platform]).pipe(
    Option.filter(() => asksToRunWithAppClosed(server.runPolicy, now))
  )
  const onPick = (event: ChangeEvent<HTMLSelectElement>): void => {
    const picked = RUN_POLICY_CHOICES.find((option) => option.value === event.target.value)
    if (picked === undefined) return
    setRunPolicy.mutate({ domain: server.domain, choice: picked.choice })
  }
  return (
    <>
      {note.pipe(
        Option.map((text) => (
          <p key="note" id={noteId} className={`text-body-3 ${styles['run-policy-picker__note']}`}>
            {text}
          </p>
        )),
        Option.getOrNull
      )}
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
          aria-describedby={Option.isSome(note) ? noteId : undefined}
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

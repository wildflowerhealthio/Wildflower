import { RunPolicy } from '@wildflowerhealthio/servers-core-js'
import { DateTime, Duration } from 'effect'

import { formatInstant } from './server-status-text.ts'

/** What {@link runPolicyText} says of each policy but `until`. */
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
 * What the run-policy field says of when the server runs; for a stored
 * `until`, the picker's own option says the same, and the server page's
 * status hero says it under the status.
 */
const runPolicyText = (policy: RunPolicy.Type, now: DateTime.Utc): string => {
  if (policy.kind !== 'until') return RUN_POLICY_TEXT[policy.kind]
  return RunPolicy.hasEndedAt(policy, now)
    ? `Ended at ${formatInstant(policy.at)}`
    : `On for ${remainingText(now, policy.at)} — until ${formatInstant(policy.at)}`
}

export { runPolicyText }

import { DateTime, Schema } from 'effect'

import type * as RunPolicy from './run-policy.ts'

/**
 * The run policy the user picks for a server: a run policy with the window
 * given as a number of seconds from now, which the host stores as `until`
 * that moment.
 *
 * @remarks
 * The host refuses `seconds` of zero or less, as `nonPositiveDuration`.
 */
const RunPolicyChoiceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('off') }),
  Schema.Struct({ kind: Schema.Literal('whileOpen') }),
  Schema.Struct({
    kind: Schema.Literal('for'),
    seconds: Schema.Int.pipe(Schema.positive()),
  }),
  Schema.Struct({ kind: Schema.Literal('always') })
)

/** A decoded {@link RunPolicyChoiceSchema}. */
type Type = typeof RunPolicyChoiceSchema.Type

/**
 * The run policy `choice` becomes when picked at `now`: a `for` becomes
 * `until` `now` plus its seconds, and every other choice the policy of its
 * own kind.
 *
 * @remarks
 * `servers-rust`'s `RunPolicyChoice::into_run_policy_at` is the conversion
 * the host stores; this one lets the base show a choice before the host
 * answers.
 */
const toRunPolicyAt = (choice: Type, now: DateTime.Utc): RunPolicy.Type =>
  choice.kind === 'for'
    ? { kind: 'until', at: DateTime.add(now, { seconds: choice.seconds }) }
    : choice

export { RunPolicyChoiceSchema as Schema, toRunPolicyAt }
export type { Type }

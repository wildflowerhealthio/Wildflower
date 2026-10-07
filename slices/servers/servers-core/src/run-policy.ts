import { DateTime, Option, Schema } from 'effect'

/**
 * When the user wants a server run, as `servers.json` stores it and the host
 * answers with it: the unit runner's own run policy, in its wire shape.
 *
 * @remarks
 * `off` never runs; `whileOpen` runs while the app is open, and for the
 * runner's two-minute grace after it closes; `until` runs while `at` is
 * ahead of the clock; `always` always runs. An `until` whose `at` has passed
 * stays as it is: the window has ended, and the server doesn't run.
 */
const RunPolicySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('off') }),
  Schema.Struct({ kind: Schema.Literal('whileOpen') }),
  Schema.Struct({ kind: Schema.Literal('until'), at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal('always') })
)

/** A decoded {@link RunPolicySchema}. */
type Type = typeof RunPolicySchema.Type

/** The kinds of run policy: `off`, `whileOpen`, `until` and `always`. */
type Kind = Type['kind']

/** The deadline of an `until` policy; none for any other. */
const deadlineOf = (policy: Type): Option.Option<DateTime.Utc> =>
  policy.kind === 'until' ? Option.some(policy.at) : Option.none()

/** Whether `policy` is an `until` whose deadline is not ahead of `now`. */
const hasEndedAt = (policy: Type, now: DateTime.Utc): boolean =>
  deadlineOf(policy).pipe(Option.exists((at) => !DateTime.lessThan(now, at)))

export { deadlineOf, hasEndedAt, RunPolicySchema as Schema }
export type { Kind, Type }

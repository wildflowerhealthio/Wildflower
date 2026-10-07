import { Schema } from 'effect'

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

export { RunPolicyChoiceSchema as Schema }
export type { Type }

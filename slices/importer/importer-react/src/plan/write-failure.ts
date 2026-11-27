/**
 * A write failure: why a write the reviewer sent did not end in an import.
 *
 * @packageDocumentation
 */
import { type BatchEntryOutcome, NO_RESPONSE_STATUS } from '@wildflowerhealthio/fhir-r4/clients'
import { Data, Option } from 'effect'

/**
 * `Refused` when the FHIR server answered and refused the transaction, so
 * nothing was written; `Unanswered` when no readable answer came back, so
 * the transaction may have been written.
 */
type Type = Data.TaggedEnum<{
  Refused: { readonly outcomes: readonly BatchEntryOutcome[] }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  Unanswered: Record<never, never>
}>

const { Refused, Unanswered, $match: match } = Data.taggedEnum<Type>()

/**
 * The failure the `outcomes` of a transaction say: `None` when every one is
 * ok, `Unanswered` when any got no readable answer (`NO_RESPONSE_STATUS`),
 * else `Refused`.
 */
const fromOutcomes = (outcomes: readonly BatchEntryOutcome[]): Option.Option<Type> => {
  if (outcomes.every(({ ok }) => ok)) return Option.none()
  return Option.some(
    outcomes.some(({ status }) => status === NO_RESPONSE_STATUS)
      ? Unanswered()
      : Refused({ outcomes })
  )
}

export { fromOutcomes, match, Unanswered }
export type { Type }

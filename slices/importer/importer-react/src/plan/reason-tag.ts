/**
 * A row's reason tag: why a record decided automatically is suggested what
 * it is, as the last line of its row says it.
 *
 * @packageDocumentation
 */
import {
  type Difference,
  type PlanResolution,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Match, Option } from 'effect'

import {
  IDENTIFIER_MATCH_ADDS_TAG,
  identifierMatchTag,
  NO_MATCH_TAG,
  NOT_REFERENCED_TAG,
} from './plan-text.ts'

/**
 * The reason of a record decided automatically: any suggestion's reason but
 * the two a record is listed under Needs a decision for
 * (`Suggestion.needsDecision`), which get a card, never a row.
 */
type DecidedReason = Exclude<
  Suggestion.Reason,
  { readonly _tag: 'SeveralIdentifierMatches' | 'NameMatchReferenced' }
>

/**
 * Whether `reason` is one a record decided automatically has: not listed
 * under Needs a decision, as `Suggestion.needsDecision` alone decides.
 */
const isDecided = (reason: Suggestion.Reason): reason is DecidedReason =>
  !Suggestion.needsDecision(reason)

/** `reason` as a record decided automatically has it; `None` for a reason listed under Needs a decision. */
const decidedReasonOf = (reason: Suggestion.Reason): Option.Option<DecidedReason> =>
  Option.liftPredicate(reason, isDecided)

/**
 * The tag of a record suggested for `reason`: "Identifier match · same as
 * existing", "Identifier match · 2 fields differ", or, when no field differs
 * but the record is counted an `Update` (it adds an identifier or a link),
 * "Identifier match · adds an identifier or a link"; "New · no match"; or
 * "New · not referenced".
 *
 * @param reason - The suggestion's reason
 * @param suggestedDifferences - What merging into the existing record the
 *   suggestion merges into would change
 * @param label - How the plan counts the record now
 *
 * @remarks
 * The reason and the differences are the suggestion's: a choice the reviewer
 * makes does not change them, since the row's Changed chip says that.
 */
const reasonTagOf = (
  reason: DecidedReason,
  suggestedDifferences: readonly Difference.Type[],
  label: PlanResolution.Label
): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      OneIdentifierMatch: () =>
        suggestedDifferences.length === 0 && label === 'Update'
          ? IDENTIFIER_MATCH_ADDS_TAG
          : identifierMatchTag(suggestedDifferences.length),
      NoMatch: () => NO_MATCH_TAG,
      NameMatchNotReferenced: () => NOT_REFERENCED_TAG,
    })
  )

export { decidedReasonOf, reasonTagOf }
export type { DecidedReason }

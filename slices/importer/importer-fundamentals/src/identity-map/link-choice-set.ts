/**
 * The link choice set: the reviewer's whole answer to the identity map, by
 * referent (one `LinkChoice` each) and by mention (one
 * `LinkChoice.MentionLinkChoice` each, for a mention chosen for on its own).
 * What a batch is resolved on.
 *
 * @packageDocumentation
 */

import * as MentionLinkChoiceSet from './mention-link-choice-set.ts'
import * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'

/** The reviewer's link choices for a batch. */
interface Type {
  /** Each referent's choice, by `Referent.key`. */
  readonly byReferent: ReferentLinkChoiceSet.Type
  /** Each mention chosen for on its own, by `MentionLinkChoiceSet.key`, over its referent's choice. */
  readonly byMention: MentionLinkChoiceSet.Type
}

/** No choice made: every referent takes its default, and no mention is chosen for on its own. */
const empty: Type = {
  byReferent: ReferentLinkChoiceSet.empty,
  byMention: MentionLinkChoiceSet.empty,
}

export { empty }
export type { Type }

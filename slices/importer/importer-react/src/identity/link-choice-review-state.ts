/**
 * What the identity map review holds for a batch: its referents, the link
 * choices each takes, and the batch resolved on those choices, which is what the
 * server diff, the preview and the confirm all see; and the states it moves
 * through.
 *
 * @packageDocumentation
 */

import type { ResolvedBatch } from '@wildflowerhealthio/importer-core'
import type {
  LinkChoice,
  Referent,
  ReferentLinkChoiceSet,
} from '@wildflowerhealthio/importer-fundamentals'
import type { Option } from 'effect'

import type * as MentionLinkOptions from './mention-link-options.ts'
import type { StoredResource } from './use-stored-resources-of-type.ts'

/** The identity map of a batch, as the screen renders and resolves it. */
interface MappedIdentityMap {
  /** Every referent of the batch, once per identity (`discoverReferents`). */
  readonly referents: readonly Referent.Type[]
  /** The choices the batch is resolved on: the defaults, under the reviewer's own, less any that cannot be resolved. */
  readonly linkChoices: ReferentLinkChoiceSet.Type
  /** The stored resources the default search found, linked to or updated, labelled, for the reviewer to pick again. */
  readonly found: readonly StoredResource[]
  /** The batch resolved on {@link MappedIdentityMap.linkChoices}: what the diff, the preview and the confirm see. */
  readonly resolved: ResolvedBatch
  /** What the rows' mention selects offer under the resolved batch's plan: each resource a referent lands on, labelled. */
  readonly mentionLinkOptions: MentionLinkOptions.Type
}

/**
 * `loading` while the default search for this batch is in flight (the screen
 * paints a status line instead of the preview), `ready` once the defaults are
 * in, `error` when the search failed and every referent took its kind's
 * default, `refused` when the batch cannot be resolved at all, with the last
 * resolving of this batch that could be, when a re-decode is what refused it,
 * so the screen can keep that review up while the reviewer undoes the change.
 */
type LinkChoiceReviewState =
  | { readonly _tag: 'loading' }
  | ({ readonly _tag: 'ready' } & MappedIdentityMap)
  | ({ readonly _tag: 'error'; readonly error: Error } & MappedIdentityMap)
  | {
      readonly _tag: 'refused'
      readonly failure: Referent.DuplicateReferent
      readonly previous: Option.Option<MappedIdentityMap>
    }

/** The review's surface: the state, the action the referent rows drive, and the one the mention selects drive. */
interface IdentityMapReview {
  readonly state: LinkChoiceReviewState
  /** Set the reviewer's choice for the referent keyed `referentKey`. */
  readonly choose: (referentKey: string, choice: LinkChoice.Type) => void
  /**
   * Set the reviewer's choice for the mention at `mentionPath` of the
   * resource reviewed under `reviewKey`, over its referent's: a mention link
   * choice in the identity map, never an edit.
   */
  readonly chooseMention: (
    reviewKey: string,
    mentionPath: string,
    choice: LinkChoice.MentionLinkChoice
  ) => void
}

export type {
  MappedIdentityMap as Mapped,
  IdentityMapReview as Review,
  LinkChoiceReviewState as Type,
}

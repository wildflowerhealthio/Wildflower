/**
 * The identity map in the screen: the batch's referents, the link choice each
 * one takes, and the batch resolved on those choices, which is what the server
 * diff, the preview and the confirm all see.
 *
 * @remarks
 * The defaults come from one search per batch
 * (`useDefaultLinkChoicesSearch`), the reviewer's choices sit on top of them
 * and their choices for single mentions beside them
 * (`useReviewerLinkChoices`), and the batch is resolved on all three
 * (`resolveMentionsWithFallback`). A choice that can no longer be resolved
 * after a re-decode (its referent changed kind, or the referent it linked to
 * is gone) is dropped, so the referent takes its default.
 *
 * The stage's failures surface as states: a failed search is `error` (every
 * referent takes its kind's default and the screen says so), and a batch two
 * decoded resources of one identity refuse (`Referent.DuplicateReferent`) is
 * `refused`, carrying the last resolving of the batch that succeeded
 * (`useLastResolvedBatch`) when a re-decode is what refused it.
 *
 * @packageDocumentation
 */

import { Effect, Either } from 'effect'
import { useMemo } from 'react'

import {
  type DecodedBatch,
  discoverReferents,
  resolveMentionsWithFallback,
} from '@wildflowerhealthio/importer-core'
import type { Referent } from '@wildflowerhealthio/importer-fundamentals'

import type * as LinkChoiceReviewState from './link-choice-review-state.ts'
import * as MentionLinkOptions from './mention-link-options.ts'
import { useDefaultLinkChoicesSearch } from './use-default-link-choices-search.ts'
import { useLastResolvedBatch } from './use-last-resolved-batch.ts'
import { useReviewerLinkChoices } from './use-reviewer-link-choices.ts'

/**
 * The batch's identity map review: its referents, their defaults from one
 * search per referent, the reviewer's choices, and the resolved batch.
 *
 * @param batch - The decoded batch (undefined until the read is `ready`)
 * @param batchId - The picked batch's id: stable across a settings re-decode,
 *   new for a fresh pick
 * @returns The state, the `choose` action and the `chooseMention` action
 */
const useLinkChoiceReview = (
  batch: DecodedBatch | undefined,
  batchId: number
): LinkChoiceReviewState.Review => {
  // Discovery reads the clock (which of a person's names is current) and
  // nothing else, so it runs synchronously here; its one failure is a state.
  const discovered = useMemo(
    (): Either.Either<readonly Referent.Type[], Referent.DuplicateReferent> | undefined =>
      batch === undefined ? undefined : Effect.runSync(Effect.either(discoverReferents(batch))),
    [batch]
  )
  const referents = discovered === undefined ? undefined : Either.getOrUndefined(discovered)

  const { searched, chosen, byMention, choose, chooseMention } = useReviewerLinkChoices(
    batchId,
    referents
  )
  const search = useDefaultLinkChoicesSearch(batchId, searched)
  const { defaults } = search
  const loading = batch === undefined || (searched.length > 0 && search.isPending)

  const mapped = useMemo(():
    | Either.Either<LinkChoiceReviewState.Mapped, Referent.DuplicateReferent>
    | undefined => {
    if (loading || batch === undefined || discovered === undefined) return undefined
    return Either.flatMap(discovered, (discoveredReferents) =>
      Either.map(
        Effect.runSync(
          Effect.either(resolveMentionsWithFallback(batch, defaults.linkChoices, chosen, byMention))
        ),
        ({ batch: resolved, linkChoices }): LinkChoiceReviewState.Mapped => ({
          referents: discoveredReferents,
          linkChoices,
          found: defaults.found,
          resolved,
          // Labelling reads the clock (which name is current) and nothing else.
          mentionLinkOptions: Effect.runSync(
            MentionLinkOptions.fromLinkTargets(discoveredReferents, resolved.plan)
          ),
        })
      )
    )
  }, [loading, batch, discovered, defaults, chosen, byMention])

  const previous = useLastResolvedBatch(batchId, mapped)

  const state = useMemo((): LinkChoiceReviewState.Type => {
    if (discovered !== undefined && Either.isLeft(discovered)) {
      return { _tag: 'refused', failure: discovered.left, previous }
    }
    if (mapped === undefined) return { _tag: 'loading' }
    return Either.match(mapped, {
      onLeft: (failure): LinkChoiceReviewState.Type => ({ _tag: 'refused', failure, previous }),
      onRight: (ready): LinkChoiceReviewState.Type =>
        search.isError
          ? {
              _tag: 'error',
              error:
                search.error instanceof Error
                  ? search.error
                  : new Error('Failed to search the server for referents'),
              ...ready,
            }
          : { _tag: 'ready', ...ready },
    })
  }, [discovered, mapped, previous, search.isError, search.error])

  return { state, choose, chooseMention }
}

export { useLinkChoiceReview }

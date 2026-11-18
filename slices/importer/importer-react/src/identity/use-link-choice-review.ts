/**
 * The identity map in the screen: the batch's referents, the link choice each
 * one takes, and the batch resolved on those choices, which is what the server
 * diff, the preview and the confirm all see.
 *
 * @remarks
 * The batch is matched once (`useStoredCandidates`), and each referent's
 * default is read off its stored candidates (`ReferentMatch.defaultChoices`).
 * The reviewer's choices sit on top of the defaults, and their choices for
 * single mentions beside them (`useReviewerLinkChoices`). The batch is
 * resolved on all three (`resolveMentionsWithFallback`). A choice that can no
 * longer be resolved after a re-decode (its referent changed kind, or the
 * referent it linked to is gone) is dropped, so the referent takes its
 * default.
 *
 * The stage's failures surface as states. A failed match is `error`: every
 * referent takes `CreateResource`, and the screen says so. A batch two
 * decoded resources of one identity refuse (`Referent.DuplicateReferent`) is
 * `refused`, carrying the last resolving of the batch that succeeded
 * (`useLastResolvedBatch`) when a re-decode is what refused it.
 *
 * @packageDocumentation
 */

import { Array, Effect, Either, HashMap, Option } from 'effect'
import { useMemo } from 'react'

import {
  type DecodedBatch,
  decodedRowsOf,
  discoverReferents,
  resolveMentionsWithFallback,
} from '@wildflowerhealthio/importer-core'
import {
  LinkableResource,
  LinkChoice,
  type Referent,
  ReferentMatch,
  StoredCandidates,
} from '@wildflowerhealthio/importer-fundamentals'

import type * as LinkChoiceReviewState from './link-choice-review-state.ts'
import * as MentionLinkOptions from './mention-link-options.ts'
import { useLastResolvedBatch } from './use-last-resolved-batch.ts'
import { type FirstDecode, useReviewerLinkChoices } from './use-reviewer-link-choices.ts'
import { useStoredCandidates } from './use-stored-candidates.ts'
import {
  labeled,
  type StoredResource,
  usePrefetchStoredResources,
} from './use-stored-resources-of-type.ts'

/**
 * The batch's identity map review: its referents, their defaults from one
 * match per batch, the reviewer's choices, and the resolved batch.
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
  const decoded = useMemo(
    (): FirstDecode | undefined =>
      batch === undefined || discovered === undefined
        ? undefined
        : Either.match(discovered, {
            onLeft: () => undefined,
            onRight: (referents) => ({
              referents,
              resources: decodedRowsOf(batch).map(({ resource }) => resource),
            }),
          }),
    [batch, discovered]
  )

  const { matched, chosen, byMention, choose, chooseMention } = useReviewerLinkChoices(
    batchId,
    decoded
  )
  usePrefetchStoredResources(matched.referents)
  // Each referent's own resource comes first, so it is the one matched when a
  // decoded row shares its literal reference.
  const matchedResources = useMemo(
    () => [...matched.referents.map(({ resource }) => resource), ...matched.resources],
    [matched]
  )
  const storedCandidatesQuery = useStoredCandidates(batchId, matchedResources)
  const { storedCandidates } = storedCandidatesQuery
  const loading =
    batch === undefined || (matchedResources.length > 0 && storedCandidatesQuery.isPending)

  // Until the candidates are in, and when the match failed, every referent
  // takes `CreateResource`.
  const defaultChoices = useMemo(
    () =>
      ReferentMatch.defaultChoices(
        matched.referents,
        Option.getOrElse(storedCandidates, () => StoredCandidates.empty)
      ),
    [matched.referents, storedCandidates]
  )
  // Labelling reads the clock and nothing else, so it runs synchronously too.
  const found = useMemo(
    (): readonly StoredResource[] =>
      Effect.runSync(
        Effect.forEach(
          Array.dedupeWith(
            Array.filterMap(HashMap.values(defaultChoices), LinkChoice.storedResourceOf),
            LinkableResource.sameRecord
          ),
          labeled
        )
      ),
    [defaultChoices]
  )

  const mapped = useMemo(():
    | Either.Either<LinkChoiceReviewState.Mapped, Referent.DuplicateReferent>
    | undefined => {
    if (loading || batch === undefined || discovered === undefined) return undefined
    return Either.flatMap(discovered, (discoveredReferents) =>
      Either.map(
        Effect.runSync(
          Effect.either(resolveMentionsWithFallback(batch, defaultChoices, chosen, byMention))
        ),
        ({ batch: resolved, linkChoices }): LinkChoiceReviewState.Mapped => ({
          referents: discoveredReferents,
          linkChoices,
          found,
          storedCandidates,
          resolved,
          mentionLinkOptions: MentionLinkOptions.fromPlan(resolved.plan),
        })
      )
    )
  }, [loading, batch, discovered, defaultChoices, found, storedCandidates, chosen, byMention])

  const previous = useLastResolvedBatch(batchId, mapped)

  const state = useMemo((): LinkChoiceReviewState.Type => {
    if (discovered !== undefined && Either.isLeft(discovered)) {
      return { _tag: 'refused', failure: discovered.left, previous }
    }
    if (mapped === undefined) return { _tag: 'loading' }
    return Either.match(mapped, {
      onLeft: (failure): LinkChoiceReviewState.Type => ({ _tag: 'refused', failure, previous }),
      onRight: (ready): LinkChoiceReviewState.Type =>
        storedCandidatesQuery.isError
          ? {
              _tag: 'error',
              error:
                storedCandidatesQuery.error instanceof Error
                  ? storedCandidatesQuery.error
                  : new Error('Failed to match the import against the server'),
              ...ready,
            }
          : { _tag: 'ready', ...ready },
    })
  }, [discovered, mapped, previous, storedCandidatesQuery.isError, storedCandidatesQuery.error])

  return { state, choose, chooseMention }
}

export { useLinkChoiceReview }

/**
 * The last resolving of a batch that succeeded, so a refusal after a re-decode
 * is shown over it while the reviewer undoes the change.
 *
 * @packageDocumentation
 */

import type { Referent } from '@wildflowerhealthio/importer-fundamentals'
import { Either, Option } from 'effect'
import { useMemo, useState } from 'react'

import type * as LinkChoiceReviewState from './link-choice-review-state.ts'

/**
 * The last resolving of the batch `batchId` names that succeeded, kept (and
 * adjusted during render, the "derive from a changed prop" pattern) across
 * the resolvings that fail.
 *
 * @param batchId - The picked batch's id; a new one forgets the last resolving
 * @param mapped - This render's resolving, undefined while loading
 * @returns The last successful resolving of this batch, or `None`
 */
const useLastResolvedBatch = (
  batchId: number,
  mapped: Either.Either<LinkChoiceReviewState.Mapped, Referent.DuplicateReferent> | undefined
): Option.Option<LinkChoiceReviewState.Mapped> => {
  const [lastReady, setLastReady] = useState<
    { readonly batchId: number; readonly mapped: LinkChoiceReviewState.Mapped } | undefined
  >(undefined)
  const readyNow = mapped === undefined ? undefined : Either.getOrUndefined(mapped)
  if (readyNow !== undefined && lastReady?.mapped !== readyNow) {
    setLastReady({ batchId, mapped: readyNow })
  }
  return useMemo(
    (): Option.Option<LinkChoiceReviewState.Mapped> =>
      lastReady?.batchId === batchId ? Option.some(lastReady.mapped) : Option.none(),
    [lastReady, batchId]
  )
}

export { useLastResolvedBatch }

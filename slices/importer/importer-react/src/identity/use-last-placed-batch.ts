/**
 * The last placing of a batch that succeeded, so a refusal after a re-decode
 * is shown over it while the reviewer undoes the change.
 *
 * @packageDocumentation
 */

import type { Referent } from '@wildflowerhealthio/importer-fundamentals'
import { Either, Option } from 'effect'
import { useMemo, useState } from 'react'

import type * as IdentityMapReviewState from './identity-map-review-state.ts'

/**
 * The last placing of the batch `batchId` names that succeeded, kept (and
 * adjusted during render, the "derive from a changed prop" pattern) across
 * the placings that fail.
 *
 * @param batchId - The picked batch's id; a new one forgets the last placing
 * @param mapped - This render's placing, undefined while loading
 * @returns The last successful placing of this batch, or `None`
 */
const useLastPlacedBatch = (
  batchId: number,
  mapped: Either.Either<IdentityMapReviewState.Mapped, Referent.DuplicateReferent> | undefined
): Option.Option<IdentityMapReviewState.Mapped> => {
  const [lastReady, setLastReady] = useState<
    { readonly batchId: number; readonly mapped: IdentityMapReviewState.Mapped } | undefined
  >(undefined)
  const readyNow = mapped === undefined ? undefined : Either.getOrUndefined(mapped)
  if (readyNow !== undefined && lastReady?.mapped !== readyNow) {
    setLastReady({ batchId, mapped: readyNow })
  }
  return useMemo(
    (): Option.Option<IdentityMapReviewState.Mapped> =>
      lastReady?.batchId === batchId ? Option.some(lastReady.mapped) : Option.none(),
    [lastReady, batchId]
  )
}

export { useLastPlacedBatch }

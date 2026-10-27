/**
 * The reviewer's own link choices for a picked batch, on top of the searched
 * defaults, and the referents the default search reads.
 *
 * @remarks
 * The choices are keyed by `Referent.key` and survive a settings re-decode: a
 * re-decode re-discovers the referents, and a referent it brings back keeps
 * its choice. A fresh pick starts over.
 *
 * @packageDocumentation
 */

import { HashMap } from 'effect'
import { useCallback, useState } from 'react'

import {
  type LinkChoice,
  type Referent,
  ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'

/** What the hook holds per picked batch, reset when the batch id changes. */
interface PerBatch {
  readonly batchId: number
  /** The referents of the batch's first decode: the ones the default search reads. */
  readonly searched: readonly Referent.Type[]
  readonly chosen: ReferentLinkChoices.Type
}

/** No referents to search for, held once so the effects keyed on it do not re-run. */
const NO_REFERENTS: readonly Referent.Type[] = []

/** The reviewer's choices for the batch in hand, the referents its search reads, and the action that sets a choice. */
interface ReviewerLinkChoices {
  /** The referents of the batch's first decode while a batch is in hand, else none. */
  readonly searched: readonly Referent.Type[]
  /** The reviewer's own choices, by `Referent.key`. */
  readonly chosen: ReferentLinkChoices.Type
  /** Set the reviewer's choice for the referent keyed `referentKey`. */
  readonly choose: (referentKey: string, choice: LinkChoice.Type) => void
}

/**
 * The reviewer's choices for the batch `batchId` names, captured on its first
 * decode.
 *
 * @param batchId - The picked batch's id: stable across a settings re-decode,
 *   new for a fresh pick
 * @param referents - The batch's referents, undefined while no batch is in
 *   hand or the batch cannot be placed
 * @returns The searched referents, the reviewer's choices, and `choose`
 */
const useReviewerLinkChoices = (
  batchId: number,
  referents: readonly Referent.Type[] | undefined
): ReviewerLinkChoices => {
  // Captured on the batch's first decode and adjusted during render off the
  // changed batch id (the "derive from a changed prop" pattern), so a
  // re-decode neither re-searches nor drops the reviewer's choices.
  const [perBatch, setPerBatch] = useState<PerBatch | undefined>(undefined)
  let current = perBatch
  if (referents !== undefined && current?.batchId !== batchId) {
    current = { batchId, searched: referents, chosen: ReferentLinkChoices.empty }
    setPerBatch(current)
  }
  // Only while a batch is in hand: after a start-over or during the next
  // pick's read, the previous batch's referents must not be searched again.
  const searched = referents === undefined ? NO_REFERENTS : (current?.searched ?? NO_REFERENTS)

  const choose = useCallback((referentKey: string, choice: LinkChoice.Type): void => {
    setPerBatch((perBatchBefore) =>
      perBatchBefore === undefined
        ? perBatchBefore
        : { ...perBatchBefore, chosen: HashMap.set(perBatchBefore.chosen, referentKey, choice) }
    )
  }, [])

  return { searched, chosen: current?.chosen ?? ReferentLinkChoices.empty, choose }
}

export { useReviewerLinkChoices }

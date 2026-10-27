/**
 * The identity map stage: placing a batch's decoded files on the reviewer's
 * referent link choices, a function of the files, the choices and the clock.
 *
 * @remarks
 * The screen runs {@link apply} before the server diff, the preview and
 * the confirm, so all three see the resources that get written. The stage
 * runs in phases, one module each: `Referent.discover` finds the batch's
 * referents, `Resolution` resolves each one's choice into its `LinkTarget`,
 * `LinkPlan.make` works out the `PlacedResource` under every literal
 * reference the links land on and `Placement` rebuilds each file with every
 * mention redirected and gives what the batch only mentions as its linked
 * records; `UnlinkedMention.collect` reads what still lands nowhere off a
 * placed file.
 *
 * @packageDocumentation
 */

import { Array, Effect } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import type * as Link from './link.ts'
import * as Placement from './placement.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import type * as Referent from './referent.ts'

/** A batch placed on the identity map: what the review, the diff and the confirm see. */
interface PlacedBatch {
  /** The batch's files placed, in the order given. */
  readonly placedFiles: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>
  /**
   * The batch's linked records: the resources it only mentions, as they will
   * be written (`Placement.linkedResources`). No file's, so no format's: the
   * batch writes them once, beside its files.
   */
  readonly linked: readonly DecodedFile.Resource[]
  /** Every referent of the batch with its link target, in discovery order. */
  readonly links: readonly Link.Type[]
}

/**
 * A batch's `decodedFiles` placed on `linkChoices`, in the same order, with
 * the resources the batch only mentions as its linked records and every
 * referent's link: the batch to review, diff and write.
 *
 * @remarks
 * A referent's mentions are redirected to its link target, whichever file
 * holds the referent: every file is placed on one plan over the batch's
 * referents. The resources the batch only mentions are the batch's linked
 * records, held once for the batch rather than in any file, so a stored
 * person several files mention is written once. The choices are made for the referents of decoded files, so it
 * is decoded files `apply` places. Applying the same choices to the
 * placed files changes nothing when they have the decoded files' referents,
 * of the same kinds: no `LinkToDecodedReferent` cycle (its provisional
 * resource is a resource there), no mention several decoded resources answer
 * to, and no mention a linked stored resource answers to (once placed, one
 * resource answers to each). Which of a person's names is current is judged
 * at the clock's now, so the clock is the one input besides the arguments.
 * Fails with `Referent.DuplicateReferent` when two decoded resources under
 * different ids are keyed by one logical reference, and with
 * `LinkChoice.InvalidLinkChoice` when a choice cannot be followed for its
 * referent.
 */
const apply = (
  decodedFiles: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<PlacedBatch, Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice> =>
  Effect.map(LinkPlan.make(decodedFiles, linkChoices), (plan): PlacedBatch => ({
    placedFiles: Array.map(decodedFiles, (decodedFile) => Placement.place(decodedFile, plan)),
    linked: Placement.linkedResources(plan),
    links: plan.links,
  }))

export { apply }
export type { PlacedBatch }

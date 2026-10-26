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
 * mention redirected, appending what the batch only mentions to the first;
 * `UnlinkedMention.collect` reads what still lands nowhere off a placed file.
 *
 * @packageDocumentation
 */

import { Array, Effect } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import * as Placement from './placement.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import type * as Referent from './referent.ts'

/**
 * A batch's `decodedFiles` placed on `linkChoices`, in the same order: the
 * files to review, diff and write.
 *
 * @remarks
 * A referent's mentions are redirected to its link target, whichever file
 * holds the referent: every file is placed on one plan over the batch's
 * referents. The resources the batch only mentions are appended once, to the
 * first file. The choices are made for the referents of decoded files, so it
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
): Effect.Effect<
  Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> =>
  Effect.map(LinkPlan.make(decodedFiles, linkChoices), (plan) => {
    const placedFiles = Array.map(decodedFiles, (decodedFile) => Placement.place(decodedFile, plan))
    return Array.modifyNonEmptyHead(placedFiles, (firstPlacedFile) =>
      Placement.appendLinkedSection(firstPlacedFile, plan)
    )
  })

export { apply }

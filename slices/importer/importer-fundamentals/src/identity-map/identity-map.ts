/**
 * The identity map stage: placing a decoded file on the reviewer's referent
 * link choices, a function of the file, the choices and the clock.
 *
 * @remarks
 * The screen runs {@link apply} before the server diff, the preview and the
 * confirm, so all three see the resources that get written. The stage
 * runs in phases, one module each: `Referent.discover` finds the referents,
 * `Resolution` resolves each one's choice into its `LinkTarget`,
 * `LinkPlan.make` works out the `PlacedResource` under every literal
 * reference the links land on and `Placement` rebuilds the file with every
 * mention redirected; `UnlinkedMention.collect` reads what still lands
 * nowhere off the placed file.
 *
 * @packageDocumentation
 */

import { Effect } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import * as Placement from './placement.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import type * as Referent from './referent.ts'

/**
 * `decodedFile` placed on `linkChoices`: the file to review, diff and write.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. The choices are
 * made for the referents of a decoded file, so it is a decoded file `apply`
 * places. Applying the same choices to the placed file changes nothing when
 * it has the decoded file's referents, of the same kinds: no
 * `LinkToDecodedReferent` cycle (its provisional resource is a resource
 * there), no mention several decoded resources answer to, and no mention a
 * linked stored resource answers to (once placed, one resource answers to
 * each). Which of a person's names is current is judged at the clock's now,
 * so the clock is the one input besides the arguments. Fails with
 * `Referent.DuplicateReferent` when two decoded resources under different ids
 * are keyed by one logical reference, and with `LinkChoice.InvalidLinkChoice`
 * when a choice cannot be followed for its referent.
 */
const apply = (
  decodedFile: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<
  DecodedFile.DecodedFile,
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> =>
  Effect.map(LinkPlan.make(decodedFile, linkChoices), (plan) => Placement.place(decodedFile, plan))

export { apply }

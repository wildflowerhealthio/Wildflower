/**
 * The identity map stage: placing a decoded file on the reviewer's referent
 * link choices, pure.
 *
 * @remarks
 * The screen runs {@link apply} as a memo before the server diff, the preview
 * and the confirm, so all three see the resources that get written. The stage
 * runs in phases, one module each: `Referent.discover` finds the referents,
 * `Resolution` resolves each one's choice into its `LinkTarget`,
 * `LinkPlan.make` works out the `PlacedResource` under every literal
 * reference the links land on, `Redirection` redirects each mention and
 * `Placement` rebuilds the file; `UnlinkedMention.collect` reads what still
 * lands nowhere off the placed file.
 *
 * @packageDocumentation
 */

import type * as DecodedFile from '../decoded-file.ts'
import * as LinkPlan from './link-plan.ts'
import * as Placement from './placement.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as UnlinkedMention from './unlinked-mention.ts'

/**
 * `decodedFile` placed on `linkChoices`: the file to review, diff and write.
 *
 * @remarks
 * A referent's mentions are redirected to its link target. Pure and
 * idempotent: applying the same choices again changes nothing.
 */
const apply = (
  decodedFile: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): DecodedFile.DecodedFile => Placement.place(decodedFile, LinkPlan.make(decodedFile, linkChoices))

/** The mentions `decodedFile` still has under `linkChoices` that land on no resource of the device. */
const unlinkedMentions = (
  decodedFile: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): readonly UnlinkedMention.Type[] => UnlinkedMention.collect(apply(decodedFile, linkChoices))

export { apply, unlinkedMentions }

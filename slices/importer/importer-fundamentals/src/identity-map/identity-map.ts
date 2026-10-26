/**
 * The identity map: the reviewer's choice for every referent an import
 * discovers, and the pure stage that places a decoded file on it.
 *
 * @remarks
 * The map is held beside the per-format selections, never inside them:
 * `StagedImport` keeps exclusions and edits only. The screen runs
 * {@link apply} as a memo before the server diff, the preview and the confirm,
 * so all three see the resources that get written. The stage runs in phases,
 * one module each: `Referent.discover` finds the referents, `Resolution`
 * resolves each one's choice into its `Destination`, `LinkPlan.make` works out
 * what every destination becomes, `Redirection` redirects each mention and
 * `Placement` rebuilds the file; `UnlinkedMention.of` reads what still names
 * nobody off the placed file.
 *
 * @packageDocumentation
 */

import type * as DecodedFile from '../decoded-file.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import * as Placement from './placement.ts'
import * as UnlinkedMention from './unlinked-mention.ts'

/**
 * `decodedFile` placed on `choices`: the file to review, diff and write.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. Pure and
 * idempotent: applying the same choices again changes nothing.
 */
const apply = (
  decodedFile: DecodedFile.DecodedFile,
  choices: LinkChoice.ByReferent
): DecodedFile.DecodedFile => Placement.place(decodedFile, LinkPlan.make(decodedFile, choices))

/** The mentions `decodedFile` still has under `choices` that name nobody on the device. */
const unlinkedMentions = (
  decodedFile: DecodedFile.DecodedFile,
  choices: LinkChoice.ByReferent
): readonly UnlinkedMention.Type[] => UnlinkedMention.of(apply(decodedFile, choices))

export { apply, unlinkedMentions }

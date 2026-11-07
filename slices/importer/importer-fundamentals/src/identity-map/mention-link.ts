/**
 * A mention link: one mention the reviewer chose a link for on its own, with
 * the link target that choice gives it. What the plan makes of the link
 * choice set by mention, as a link is what it makes of the set by referent.
 *
 * @packageDocumentation
 */

import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Array, HashMap, Match, Option, pipe } from 'effect'

import type * as LinkChoice from './link-choice.ts'
import * as LinkTarget from './link-target.ts'
import type * as Link from './link.ts'
import type * as MentionLinkChoiceSet from './mention-link-choice-set.ts'

/** The mention at `path` of the resource reviewed under `reviewKey`, and the link target chosen for it. */
interface Type {
  readonly reviewKey: string
  readonly path: string
  readonly target: LinkTarget.Type
}

/**
 * The link target a mention choice gives its mention, given the batch's
 * links: a `LinkToStoredResource` that stored resource, a `DontLink`
 * `Unlinked`, and a `LinkToDecodedReferent` its referent's link target.
 * `None` for a `LinkToDecodedReferent` whose referent the batch does not
 * hold: that mention is redirected where its own referent's link target
 * says, as one with no choice is.
 */
const linkTargetOfChoice = (
  linksByReferent: HashMap.HashMap<LogicalReference.Key, Link.Type>,
  choice: LinkChoice.MentionLinkChoice
): Option.Option<LinkTarget.Type> =>
  Match.value(choice).pipe(
    Match.tag('LinkToStoredResource', ({ resource }) =>
      Option.some<LinkTarget.Type>(LinkTarget.Stored({ resource }))
    ),
    Match.tag('LinkToDecodedReferent', ({ referentKey }) =>
      Option.map(HashMap.get(linksByReferent, referentKey), ({ target }): LinkTarget.Type => target)
    ),
    Match.tag('DontLink', () => Option.some(LinkTarget.Unlinked())),
    Match.exhaustive
  )

/**
 * The mention links the link choice set by mention, `byMention`, makes
 * given the batch's links by referent, `linksByReferent`: one per chosen mention whose choice gives it a
 * link target ({@link linkTargetOfChoice}).
 */
const fromChoices = (
  linksByReferent: HashMap.HashMap<LogicalReference.Key, Link.Type>,
  byMention: MentionLinkChoiceSet.Type
): readonly Type[] =>
  pipe(
    HashMap.toEntries(byMention),
    Array.filterMap(([{ reviewKey, path }, choice]) =>
      Option.map(linkTargetOfChoice(linksByReferent, choice), (target): Type => ({
        reviewKey,
        path,
        target,
      }))
    )
  )

export { fromChoices }
export type { Type }

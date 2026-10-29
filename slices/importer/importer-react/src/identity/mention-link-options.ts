/**
 * The options a mention's select offers: exactly the plan's resolved
 * resources, one per record that will exist once the batch is written, of the
 * type the mention names, each labelled and paired with the mention link
 * choice picking it makes.
 *
 * @remarks
 * A pick onto a record a referent of the batch owns (its decoded resource,
 * or the provisional one its logical reference stands for) is
 * `LinkToDecodedReferent` of that referent, so the mention follows the
 * referent when it is later linked to a stored one; a pick onto a stored
 * record no referent owns is `LinkToStoredResource`, which no referent's
 * later choice moves.
 *
 * @packageDocumentation
 */

import {
  type LinkableLogicalReference,
  LinkChoice,
  LinkPlan,
  Referent,
  type ResolvedResource,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Option, pipe } from 'effect'

import * as LinkChoiceOptions from './link-choice-options.ts'

/**
 * One option of a mention's select: a resolved resource as a link choice
 * option (its value and its label), the mention link choice picking it
 * makes, and the literal reference it is written under.
 */
interface MentionLinkOption extends LinkChoiceOptions.Option {
  readonly choice: LinkChoice.MentionLinkChoice
  readonly resourceType: LinkableLogicalReference.ResourceType
  readonly literalReference: string
}

/** What the mention selects offer: every resolved resource as an option, and each one's label. */
interface MentionLinkOptions {
  readonly options: readonly MentionLinkOption[]
  /** Each resolved resource's label, by its literal reference: how a row names its subject. */
  readonly labelsByLiteralReference: ReadonlyMap<string, string>
}

/** Nothing offered: the plan resolves no resource, so no mention can be picked for. */
const empty: MentionLinkOptions = { options: [], labelsByLiteralReference: new Map() }

/** The mention link choice picking `resolvedResource`: its owner referent's, else the stored resource itself. */
const choiceOf = ({
  resource,
  ownerReferent,
}: ResolvedResource.Type): LinkChoice.MentionLinkChoice =>
  Option.match(ownerReferent, {
    onNone: () => LinkChoice.LinkToStoredResource({ resource }),
    onSome: (owner) => LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(owner) }),
  })

/** `resolvedResource` as a mention select option. */
const optionOf = (resolvedResource: ResolvedResource.Type): MentionLinkOption => {
  const choice = choiceOf(resolvedResource)
  return {
    value: LinkChoiceOptions.valueOf(choice),
    label: resolvedResource.label,
    choice,
    resourceType: resolvedResource.resource.resourceType,
    literalReference: resolvedResource.resolvedLiteralReference,
  }
}

/** What the mention selects offer under `plan`: each of its resolved resources, in plan order. */
const fromPlan = (plan: LinkPlan.Type): MentionLinkOptions => {
  const options = pipe(LinkPlan.resolvedResources(plan), Array.map(optionOf))
  return {
    options,
    labelsByLiteralReference: new Map(
      options.map(({ literalReference, label }) => [literalReference, label])
    ),
  }
}

/** The options for a mention naming `type`. */
const forType = (
  mentionLinkOptions: MentionLinkOptions,
  type: LinkableLogicalReference.ResourceType
): readonly MentionLinkOption[] =>
  Array.filter(mentionLinkOptions.options, ({ resourceType }) => resourceType === type)

export { empty, forType, fromPlan }
export type { MentionLinkOption as Option, MentionLinkOptions as Type }

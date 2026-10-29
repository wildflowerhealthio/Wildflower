/**
 * The options a referent's select offers: each `LinkChoice` its kind allows,
 * labelled, in the four groups the select lists them in.
 *
 * @remarks
 * A referent with a resource offers `New` (its own resource becomes the
 * record), or, when a stored resource under its own id is known (a
 * re-import), an update of that copy in its place, and a stored resource. One
 * named only by mentions offers a stored resource, the new record each other
 * referent of its type creates (a `LinkToDecodedReferent`), `New` when its
 * logical reference stands for a provisional record, and `Don't link`. The
 * stored resources offered are the default search's hits and the server's
 * own, read up front.
 *
 * @packageDocumentation
 */

import {
  LinkableResource,
  LinkChoice,
  LinkPlan,
  LinkTarget,
  Referent,
  ReferentLinkChoiceSet,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Option } from 'effect'

import {
  DONT_LINK_LABEL,
  NEW_LABEL,
  newAsLabel,
  sameAsLabel,
  UPDATE_LABEL,
} from './referent-text.ts'
import type { StoredResource } from './use-stored-resources-of-type.ts'

/** One option of a referent's select: the choice it stands for and its label. */
interface LinkChoiceOption {
  readonly value: string
  readonly label: string
  readonly choice: LinkChoice.Type
}

/** A referent's options: those before the groups, the two groups, and those after. */
interface LinkChoiceOptions {
  readonly leading: readonly LinkChoiceOption[]
  readonly onServer: readonly LinkChoiceOption[]
  readonly inImport: readonly LinkChoiceOption[]
  readonly trailing: readonly LinkChoiceOption[]
}

/** Every option of `options`, in the order the select lists them. */
const all = (options: LinkChoiceOptions): readonly LinkChoiceOption[] => [
  ...options.leading,
  ...options.onServer,
  ...options.inImport,
  ...options.trailing,
]

/** A choice as an option value, unique among one select's options. */
const valueOf = (choice: LinkChoice.Type): string =>
  LinkChoice.match(choice, {
    CreateResource: () => 'create',
    DontLink: () => 'dont-link',
    UpdateStoredResource: ({ resource }) =>
      `update:${LinkableResource.literalReferenceOf(resource)}`,
    LinkToStoredResource: ({ resource }) =>
      `stored:${LinkableResource.literalReferenceOf(resource)}`,
    LinkToDecodedReferent: ({ referentKey }) => `decoded:${referentKey}`,
  })

const optionOf = (choice: LinkChoice.Type, label: string): LinkChoiceOption => ({
  value: valueOf(choice),
  label,
  choice,
})

/** The option that links to a stored resource, under its label. */
const storedOption = ({ resource, label }: StoredResource): LinkChoiceOption =>
  optionOf(LinkChoice.LinkToStoredResource({ resource }), label)

const sameValue = (left: LinkChoiceOption, right: LinkChoiceOption): boolean =>
  left.value === right.value

/** Whether `referent` writes a record of its own, new or over its stored copy, and that lands on a resource. */
const writesOwnRecord = (
  referent: Referent.Type,
  linkChoices: ReferentLinkChoiceSet.Type,
  plan: LinkPlan.Type
): boolean => {
  const choice = ReferentLinkChoiceSet.forReferent(linkChoices, referent)
  return (
    (LinkChoice.is('CreateResource')(choice) || LinkChoice.is('UpdateStoredResource')(choice)) &&
    LinkPlan.linkTargetIfReferentKey(plan, Referent.key(referent)).pipe(
      Option.exists((linkTarget) => !LinkTarget.is('Unlinked')(linkTarget))
    )
  )
}

/** Everything the options of one referent are read from. */
interface LinkChoiceOptionInputs {
  /** The batch's referents, once per identity. */
  readonly referents: readonly Referent.Type[]
  /** The choices the batch is resolved on, by `Referent.key`. */
  readonly linkChoices: ReferentLinkChoiceSet.Type
  /** The plan the batch was resolved on under `linkChoices`: each referent's link target. */
  readonly plan: LinkPlan.Type
  /** The stored resources of the referent's type: the search's hits, then the server's own. */
  readonly storedOfType: readonly StoredResource[]
  /** {@link LinkChoiceOptionInputs.storedOfType} as options, built once per group. */
  readonly onServer: readonly LinkChoiceOption[]
}

/**
 * The stored copy of `decoded` under its own literal reference, when one is
 * known: among the stored resources of its type, else the one its `current`
 * choice updates.
 */
const storedCopyOf = (
  decoded: LinkableResource.WithId,
  current: LinkChoice.Type,
  storedOfType: readonly StoredResource[]
): Option.Option<LinkableResource.WithId> =>
  Array.findFirst(storedOfType, ({ resource: stored }) =>
    LinkableResource.sameRecord(stored, decoded)
  ).pipe(
    Option.map(({ resource }) => resource),
    Option.orElse(() =>
      Option.map(
        Option.liftPredicate(current, LinkChoice.is('UpdateStoredResource')),
        ({ resource }) => resource
      )
    )
  )

/**
 * The options `referent`'s select offers under `current`, its choice: those
 * its kind allows, with the stored resource or the referent `current` names
 * among them.
 */
const forReferent = (
  referent: Referent.Type,
  current: LinkChoice.Type,
  inputs: LinkChoiceOptionInputs
): LinkChoiceOptions => {
  // A stored resource the choice names but the lists do not is offered by its literal reference.
  const currentOption = Option.liftPredicate(current, LinkChoice.is('LinkToStoredResource')).pipe(
    Option.map(({ resource }) =>
      storedOption({ resource, label: LinkableResource.literalReferenceOf(resource) })
    ),
    Option.filter((option) => !inputs.onServer.some((listed) => sameValue(listed, option)))
  )
  const onServer = Option.match(currentOption, {
    onNone: () => inputs.onServer,
    onSome: (option) => [...inputs.onServer, option],
  })
  return Referent.match(referent, {
    // With a stored copy under its own id, the update takes New's place; New
    // stays offered only while it is the choice, so the select shows it.
    AsResource: ({ resource }) => ({
      leading: Option.match(storedCopyOf(resource, current, inputs.storedOfType), {
        onNone: () => [optionOf(LinkChoice.CreateResource(), NEW_LABEL)],
        onSome: (storedCopy) => [
          optionOf(LinkChoice.UpdateStoredResource({ resource: storedCopy }), UPDATE_LABEL),
          ...(LinkChoice.is('CreateResource')(current)
            ? [optionOf(LinkChoice.CreateResource(), NEW_LABEL)]
            : []),
        ],
      }),
      onServer,
      inImport: [],
      trailing: [],
    }),
    ByMentionOnly: ({ logicalReference }) => {
      const others = inputs.referents.filter(
        (other) =>
          other.logicalReference.type === logicalReference.type &&
          Referent.key(other) !== Referent.key(referent)
      )
      const linkedCurrently = LinkChoice.is('LinkToDecodedReferent')(current)
        ? others.filter((other) => Referent.key(other) === current.referentKey)
        : []
      const inImport = Array.dedupeWith(
        [
          ...others
            .filter((other) => writesOwnRecord(other, inputs.linkChoices, inputs.plan))
            .map((other) =>
              optionOf(
                LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(other) }),
                newAsLabel(other.label)
              )
            ),
          ...linkedCurrently.map((other) =>
            optionOf(
              LinkChoice.LinkToDecodedReferent({ referentKey: Referent.key(other) }),
              sameAsLabel(other.label)
            )
          ),
        ],
        sameValue
      )
      const provisional = Option.isSome(LinkableResource.tryProvisionalFrom(logicalReference))
        ? [optionOf(LinkChoice.CreateResource(), NEW_LABEL)]
        : []
      return {
        leading: [],
        onServer,
        inImport,
        trailing: [...provisional, optionOf(LinkChoice.DontLink(), DONT_LINK_LABEL)],
      }
    },
  })
}

export { all, forReferent, storedOption, valueOf, writesOwnRecord }
export type {
  LinkChoiceOptionInputs as Inputs,
  LinkChoiceOption as Option,
  LinkChoiceOptions as Type,
}

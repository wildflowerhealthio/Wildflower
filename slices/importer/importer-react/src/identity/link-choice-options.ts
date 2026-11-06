/**
 * The options a referent's select offers: each `LinkChoice` it allows,
 * labelled, in the two groups the select lists them in.
 *
 * @remarks
 * A referent offers `New` (its own record is written), or, when a stored
 * resource under its own id is known (a re-import), an update of that copy in
 * its place, and a stored resource. The stored resources offered are the
 * default search's hits and the server's own, read up front. `valueOf` also
 * values a mention's choices, which its own select offers
 * (`MentionLinkOptions`).
 *
 * @packageDocumentation
 */

import {
  LinkableResource,
  LinkChoice,
  type Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Option } from 'effect'

import { NEW_LABEL, UPDATE_LABEL } from './referent-text.ts'
import type { StoredResource } from './use-stored-resources-of-type.ts'

/** One option of a referent's select: the choice it stands for and its label. */
interface LinkChoiceOption {
  readonly value: string
  readonly label: string
  readonly choice: LinkChoice.Type
}

/** A referent's options: those before the stored group, and the stored group. */
interface LinkChoiceOptions {
  readonly leading: readonly LinkChoiceOption[]
  readonly onServer: readonly LinkChoiceOption[]
}

/** Every option of `options`, in the order the select lists them. */
const all = (options: LinkChoiceOptions): readonly LinkChoiceOption[] => [
  ...options.leading,
  ...options.onServer,
]

/** A referent's or a mention's choice as an option value, unique among one select's options. */
const valueOf = (choice: LinkChoice.Type | LinkChoice.MentionLinkChoice): string =>
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

/** Everything the options of one referent are read from. */
interface LinkChoiceOptionInputs {
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
    Option.liftPredicate(stored, () => LinkableResource.sameRecord(stored, decoded))
  ).pipe(
    Option.orElse(() =>
      Option.map(
        Option.liftPredicate(current, LinkChoice.is('UpdateStoredResource')),
        ({ resource }) => resource
      )
    )
  )

/**
 * The options `referent`'s select offers under `current`, its choice, with
 * the stored resource `current` names among them.
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
  return {
    // With a stored copy under its own id, the update takes New's place; New
    // stays offered only while it is the choice, so the select shows it.
    leading: Option.match(storedCopyOf(referent.resource, current, inputs.storedOfType), {
      onNone: () => [optionOf(LinkChoice.CreateResource(), NEW_LABEL)],
      onSome: (storedCopy) => [
        optionOf(LinkChoice.UpdateStoredResource({ resource: storedCopy }), UPDATE_LABEL),
        ...(LinkChoice.is('CreateResource')(current)
          ? [optionOf(LinkChoice.CreateResource(), NEW_LABEL)]
          : []),
      ],
    }),
    onServer: Option.match(currentOption, {
      onNone: () => inputs.onServer,
      onSome: (option) => [...inputs.onServer, option],
    }),
  }
}

export { all, forReferent, storedOption, valueOf }
export type {
  LinkChoiceOptionInputs as Inputs,
  LinkChoiceOption as Option,
  LinkChoiceOptions as Type,
}

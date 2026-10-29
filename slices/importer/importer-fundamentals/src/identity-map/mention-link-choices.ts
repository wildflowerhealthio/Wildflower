/**
 * The mention link choices: what the reviewer chooses for one mention of one
 * resource, over whatever its referent's choice says, by the mention's key.
 * Held in the identity map beside the `ReferentLinkChoices` and resolved by
 * the plan, never written into the resource as an edit.
 *
 * @remarks
 * A mention's own choice is one of the referent choices that writes nothing:
 * `LinkToStoredResource` (a resource already on the device),
 * `LinkToDecodedReferent` (wherever that referent lands, so a mention picked
 * onto a referent's own record follows the referent when it is later linked
 * to a stored one) or `DontLink` (its literal dropped, its `identifier` and
 * `display` kept). It teaches nothing and writes nothing: a stored resource
 * picked for one mention already exists on the device, and the referent the
 * mention is picked onto assumes nothing for it. A mention with no choice of
 * its own lands where its referent's choice says.
 *
 * @packageDocumentation
 */

import type { Option } from 'effect'
import { HashMap } from 'effect'

import type * as LinkChoice from './link-choice.ts'

/** What the reviewer may choose for one mention: a referent choice that writes nothing. */
type Choice =
  | LinkChoice.LinkToStoredResourceType
  | LinkChoice.LinkToDecodedReferentType
  | LinkChoice.DontLinkType

/** Whether a referent choice is one a mention may take on its own. */
const isChoice = (choice: LinkChoice.Type): choice is Choice =>
  choice._tag === 'LinkToStoredResource' ||
  choice._tag === 'LinkToDecodedReferent' ||
  choice._tag === 'DontLink'

/** Every chosen mention's choice, by {@link key}. */
type Type = HashMap.HashMap<string, Choice>

/** No mention chosen for on its own: every mention lands where its referent does. */
const empty: Type = HashMap.empty()

/**
 * The key of the mention at `mentionPath` (`Mention.Type.path`) in the
 * resource reviewed under `reviewKey` (a `DecodedFile.Resource`'s `key`).
 *
 * @remarks
 * A review key is unique across a batch (`FormatDecode.keyPrefix`), and a
 * mention path never holds a `#`, so the key names one mention of the batch.
 */
const key = (reviewKey: string, mentionPath: string): string => `${reviewKey}#${mentionPath}`

/** The choice `mentionLinkChoices` holds for the mention at `mentionPath` of the resource reviewed under `reviewKey`, if any. */
const forMention = (
  mentionLinkChoices: Type,
  reviewKey: string,
  mentionPath: string
): Option.Option<Choice> => HashMap.get(mentionLinkChoices, key(reviewKey, mentionPath))

/** `mentionLinkChoices` with `choice` set for that mention. */
const set = (
  mentionLinkChoices: Type,
  reviewKey: string,
  mentionPath: string,
  choice: Choice
): Type => HashMap.set(mentionLinkChoices, key(reviewKey, mentionPath), choice)

export { empty, forMention, isChoice, key, set }
export type { Choice, Type }

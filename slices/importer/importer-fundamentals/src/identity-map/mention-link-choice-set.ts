/**
 * The mention link choice set: the reviewer's link choice set by mention,
 * what they choose for one mention of one resource, over whatever its
 * referent's choice says, by the mention's key. Held in the identity map
 * beside the `ReferentLinkChoiceSet` and resolved by the plan, never written
 * into the resource as an edit.
 *
 * @remarks
 * A mention's own choice is a `LinkChoice.MentionLinkChoice`, a referent
 * choice with the writing options taken away: `LinkToStoredResource` (a
 * resource already on the device), `LinkToDecodedReferent` (wherever that
 * referent is linked, so a mention picked onto a referent's own record
 * follows the referent when it is later linked to a stored one) or
 * `DontLink` (its literal dropped, its `identifier` and `display` kept). It
 * teaches nothing and writes nothing: a stored resource picked for one
 * mention already exists on the device, and the referent the mention is
 * picked onto assumes nothing for it. A mention with no choice of its own is
 * redirected where its referent's choice says.
 *
 * @packageDocumentation
 */

import type { Option } from 'effect'
import { Data, HashMap } from 'effect'

import type * as LinkChoice from './link-choice.ts'

/**
 * Which mention a choice is for: the resource it is made in, by the review
 * key it is reviewed under (a `DecodedFile.Resource`'s `key`), and its
 * `path` in it (`Mention.Type.path`). A review key is unique across a batch
 * (`FormatDecode.keyPrefix`), so a key names one mention of the batch.
 */
interface Key {
  readonly reviewKey: string
  readonly path: string
}

/** Every chosen mention's choice, by its {@link Key}. */
type Type = HashMap.HashMap<Key, LinkChoice.MentionLinkChoice>

/** No mention chosen for on its own: every mention is redirected where its referent's choice says. */
const empty: Type = HashMap.empty()

/** The key of the mention at `path` in the resource reviewed under `reviewKey`, compared by value. */
const key = (reviewKey: string, path: string): Key => Data.struct({ reviewKey, path })

/** The choice `byMention` holds for the mention at `path` of the resource reviewed under `reviewKey`, if any. */
const forMention = (
  byMention: Type,
  reviewKey: string,
  path: string
): Option.Option<LinkChoice.MentionLinkChoice> => HashMap.get(byMention, key(reviewKey, path))

/** `byMention` with `choice` set for that mention. */
const set = (
  byMention: Type,
  reviewKey: string,
  path: string,
  choice: LinkChoice.MentionLinkChoice
): Type => HashMap.set(byMention, key(reviewKey, path), choice)

export { empty, forMention, key, set }
export type { Key, Type }

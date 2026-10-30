/**
 * The referent link choice set: the reviewer's link choice set by referent,
 * a `LinkChoice` for every referent an import discovers, by `Referent.key`.
 * What `Link.fromChoices` makes the plan's links from.
 *
 * @remarks
 * Held beside the per-format selections, never inside them: `StagedImport`
 * keeps exclusions and edits only. A referent missing from it takes its
 * default ({@link defaultFor}), which is what {@link forReferent} reads.
 *
 * @packageDocumentation
 */

import { HashMap, Option } from 'effect'

import * as LinkChoice from './link-choice.ts'
import * as Referent from './referent.ts'

type Type = HashMap.HashMap<string, LinkChoice.Type>

/** No choice made for any referent: every referent takes its default. */
const empty: Type = HashMap.empty()

/** The choice a referent takes when the reviewer has made none: `CreateResource` with a resource, else `DontLink`. */
const defaultFor = (referent: Referent.Type): LinkChoice.Type =>
  Referent.match(referent, {
    AsResource: () => LinkChoice.CreateResource(),
    ByMentionOnly: () => LinkChoice.DontLink(),
  })

/** The choice `byReferent` holds for `referent`, else its default. */
const forReferent = (byReferent: Type, referent: Referent.Type): LinkChoice.Type =>
  HashMap.get(byReferent, Referent.key(referent)).pipe(Option.getOrElse(() => defaultFor(referent)))

/** `over`'s choices laid over `under`'s: a referent `over` holds a choice for takes that one. */
const union = (under: Type, over: Type): Type => HashMap.union(under, over)

/** `byReferent` without a choice for the referent keyed `referentKey`. */
const remove = (byReferent: Type, referentKey: string): Type =>
  HashMap.remove(byReferent, referentKey)

export { defaultFor, empty, forReferent, remove, union }
export type { Type }

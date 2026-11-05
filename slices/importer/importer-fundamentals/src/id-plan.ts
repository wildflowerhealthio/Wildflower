/**
 * The id plan of one file set: the id every record of the set is stored
 * under, decided before any is adopted.
 *
 * @remarks
 * As a FHIR server processes a transaction bundle: it first decides the id
 * every entry is stored under, then rewrites each reference between entries
 * to the id its target got. A keyed record's id is the one its key derives,
 * so a re-import lands on the same id; a keyless one's is minted. The plan
 * answers both questions adoption asks: the id a record is stored under
 * ({@link idFor}), and the literal reference a logical one resolves to
 * ({@link referenceTo}).
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Array as Arr, Data, Option } from 'effect'

import type * as DecodedFileSet from './decoded-file-set.ts'

/** The id a keyed record's key derives: `localResourceId(key.system, Type, key.value)`. */
interface Derived {
  readonly _tag: 'Derived'
  readonly id: string
}

/** The id minted for a keyless record: a fresh one on every decode. */
interface Minted {
  readonly _tag: 'Minted'
  readonly id: string
}

/** The id one record is stored under, and whether its key derived it or it was minted. */
type PlannedId = Derived | Minted

const { Derived, Minted, $match: match } = Data.taggedEnum<PlannedId>()

/** The id plan of one file set, built once by {@link of}. */
interface Type {
  /** Each record's planned id, by its entry's `fullUrl`. */
  readonly idsByFullUrl: ReadonlyMap<string, PlannedId>
  /** Each keyed record's derived id, by its type and key ({@link typedKeyText}). */
  readonly derivedIdsByTypedKey: ReadonlyMap<string, string>
}

/**
 * How the plan spells a record's type and key: unambiguous whatever the
 * system and value hold.
 */
const typedKeyText = (resourceType: string, { system, value }: DetachedResource.Key): string =>
  JSON.stringify([resourceType, system, value])

/**
 * The id plan of a file set's `entries`: each keyed record's id derived once
 * from its key, and each keyless record's minted by `mintId`, in entry order.
 *
 * @param entries - Every entry of the set, whichever section holds it; each
 *   `fullUrl` unique among them
 * @param mintId - Mints the id of a keyless record; random outside tests
 */
const of = (entries: readonly DecodedFileSet.Entry[], mintId: () => string): Type => {
  const planned = entries.map(({ fullUrl, resource }) => {
    const key = DetachedResource.keyOf(resource)
    return {
      fullUrl,
      typedKey: Option.map(key, (recordKey) => typedKeyText(resource.resourceType, recordKey)),
      plannedId: Option.match(key, {
        onSome: ({ system, value }): PlannedId =>
          Derived({ id: localResourceId(system, resource.resourceType, value) }),
        onNone: () => Minted({ id: mintId() }),
      }),
    }
  })
  return {
    idsByFullUrl: new Map(planned.map(({ fullUrl, plannedId }) => [fullUrl, plannedId])),
    derivedIdsByTypedKey: new Map(
      Arr.filterMap(planned, ({ typedKey, plannedId }) =>
        Option.map(typedKey, (text): readonly [string, string] => [text, plannedId.id])
      )
    ),
  }
}

/**
 * The id the record of the entry at `fullUrl` is stored under.
 *
 * @throws An `Error` when `plan` was not built from an entry at `fullUrl`:
 *   a caller asking about a record of another set is a bug, not a missing id.
 */
const idFor = (plan: Type, fullUrl: string): PlannedId => {
  const plannedId = plan.idsByFullUrl.get(fullUrl)
  if (plannedId === undefined) {
    throw new Error(`the id plan holds no entry at ${fullUrl}`)
  }
  return plannedId
}

/**
 * The literal reference the record of `resourceType` keyed by `key` is stored
 * under, `<Type>/<id>`, when the set holds it; `None` otherwise.
 *
 * @remarks
 * A lookup of an id the plan already holds: a reference to a record the set
 * does not hold costs no `localResourceId`. A keyless record is never found,
 * since nothing names it by key.
 */
const referenceTo = (
  plan: Type,
  resourceType: string,
  key: DetachedResource.Key
): Option.Option<string> =>
  Option.map(
    Option.fromNullable(plan.derivedIdsByTypedKey.get(typedKeyText(resourceType, key))),
    (id) => `${resourceType}/${id}`
  )

export { Derived, idFor, match, Minted, of, referenceTo }
export type { PlannedId, Type }

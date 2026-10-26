/**
 * The reviewer's choice for every identity an import discovers, and the pure
 * stage that files a decoded file on it.
 *
 * @remarks
 * The map is held beside the per-format selections, never inside them:
 * `StagedImport` keeps exclusions and edits only. The screen runs
 * {@link apply} as a memo before the server diff, the preview and the
 * confirm, so all three see the resources that get written.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Practitioner,
  ResourceReferences,
  type FhirResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Option, Schema, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as IdentityRow from './identity-row.ts'
import * as Identity from './identity.ts'
import * as ReferenceSlot from './reference-slot.ts'
import * as Target from './target.ts'

/** Each row's target, keyed by `IdentityRow.key`. A row missing from it takes its default. */
type Type = ReadonlyMap<string, Target.Type>

/** A slot whose reference the map leaves on no resource. */
interface Unresolved {
  /** The `DecodedFile.Resource` key of the resource carrying it. */
  readonly reviewKey: string
  /** `subject`, `requester`, `performer[0]`, `performer[0].actor`: see `ReferenceSlot`. */
  readonly path: string
  /** The reference as `apply` leaves it; `null` for a missing `subject`. */
  readonly reference: IdentifierAndReference.ReferenceType | null
}

/** The title of the section `apply` appends stored resources that only id-only rows link to. */
const LINKED_SECTION_TITLE = 'Linked'

/** A resource's relative literal, `Type/<id>`: what references to it carry. */
const literalOf = (resource: { readonly resourceType: string; readonly id: string }): string =>
  `${resource.resourceType}/${resource.id}`

/** A decoded resource's literal, or `None` when it has no `id` to be referenced by. */
const literalOfDecoded = (resource: FhirResource): Option.Option<string> =>
  Option.map(Option.fromNullable(resource.id), (id) =>
    literalOf({ resourceType: resource.resourceType, id })
  )

/** The review key `apply` appends a stored resource under in the Linked section. */
const linkedKey = (resource: Target.StoredResource): string => `linked:${literalOf(resource)}`

/** `row`'s target in `map`, else its kind's default: `'new'` for a resource, `'dontLink'` for an id. */
const targetOf = (map: Type, row: IdentityRow.Type): Target.Type =>
  map.get(IdentityRow.key(row)) ?? (row._tag === 'resource' ? 'new' : 'dontLink')

const decodePractitioner = Schema.decodeSync(Practitioner.Schema)

/** The `Practitioner` minted for a name identity: its name as `text`, the identity as identifier. */
const mint = (identity: Identity.Type): Target.Minted => {
  const id = localResourceId(identity.system.href, 'Practitioner', identity.value)
  return {
    _tag: 'minted',
    resource: {
      ...decodePractitioner({
        resourceType: 'Practitioner',
        id,
        identifier: [{ system: identity.system.href, value: identity.value }],
        name: [{ text: identity.value }],
      }),
      id,
    },
  }
}

/** What `'new'` means for `row`: its own resource, a minted one for a name, else `'dontLink'`. */
const newFor = (row: IdentityRow.Type): Target.Resolved => {
  if (row._tag === 'resource') return { _tag: 'newFromRow', row }
  return Identity.isNameIdentity(row.identity) ? mint(row.identity) : 'dontLink'
}

const resolveFrom = (
  map: Type,
  rows: ReadonlyMap<string, IdentityRow.Type>,
  start: IdentityRow.Type,
  row: IdentityRow.Type,
  visited: ReadonlySet<string>
): Target.Resolved => {
  const target = targetOf(map, row)
  if (Target.isStored(target) && target.resource.resourceType === row.identity.resourceType) {
    return target
  }
  if (row._tag === 'resource' || target === 'new') return newFor(row)
  if (!Target.isRow(target)) return 'dontLink'
  const next = rows.get(target.key)
  // A row of another type is an impossible link: a `subject` never lands on a Practitioner.
  if (next === undefined || next.identity.resourceType !== row.identity.resourceType) {
    return 'dontLink'
  }
  return visited.has(target.key)
    ? newFor(start)
    : resolveFrom(map, rows, start, next, new Set([...visited, target.key]))
}

/** What `row` comes to under `map`, given every row of its file keyed by `IdentityRow.key`. */
const resolveIn = (
  map: Type,
  rows: ReadonlyMap<string, IdentityRow.Type>,
  row: IdentityRow.Type
): Target.Resolved => resolveFrom(map, rows, row, row, new Set([IdentityRow.key(row)]))

const rowIndex = (rows: readonly IdentityRow.Type[]): ReadonlyMap<string, IdentityRow.Type> =>
  new Map(rows.map((row) => [IdentityRow.key(row), row]))

/**
 * What `row` comes to under `map`, following `row` targets to the end.
 *
 * @param rows - Every row of the decoded file, as `IdentityRow.discover` found them
 *
 * @remarks
 * A combination the row's kind does not allow reads as its default: a
 * resource-backed row targeting a row, `'dontLink'`, or a stored resource of
 * another type is `'new'`; an id-only row targeting a stored resource of
 * another type, a row of another type, or a row the file does not hold is
 * `'dontLink'`. `'new'` on an id-only row mints a `Practitioner` when its
 * identity is a printed name and reads as `'dontLink'` otherwise. A cycle
 * resolves to `'new'` for the row resolved, so only a name row in one mints.
 */
const resolve = (
  map: Type,
  rows: readonly IdentityRow.Type[],
  row: IdentityRow.Type
): Target.Resolved => resolveIn(map, rowIndex(rows), row)

/** The identifiers a row teaches the resource it resolves to. */
const taughtBy = (row: IdentityRow.Type): readonly IdentifierAndReference.IdentifierType[] =>
  row._tag === 'resource' ? row.identifiers : [Identity.toIdentifier(row.identity)]

/** The literal reference a resolution points at, or `None` for `'dontLink'` or an id-less resource. */
const literalOfResolved = (resolved: Target.Resolved): Option.Option<string> => {
  if (resolved === 'dontLink') return Option.none()
  return resolved._tag === 'newFromRow'
    ? literalOfDecoded(resolved.row.resource)
    : Option.some(literalOf(resolved.resource))
}

/**
 * The decoded file filed on `map`: the file to review, diff and write.
 *
 * @remarks
 * - A resource-backed row linked to a stored resource: the stored resource,
 *   with every identifier the row carries that it lacks appended, replaces the
 *   source resource under the same review key, and every literal
 *   `Type/<source id>` is re-pointed at `Type/<stored id>`.
 * - An identifier-only reference to a row that resolves to a resource gains
 *   that resource's literal, keeping its `display` and its own `identifier`.
 * - A stored resource that only id-only rows link to is appended, carrying
 *   their identifiers, under {@link LINKED_SECTION_TITLE} at the end, so the
 *   diff shows what it gained. So is the `Practitioner` a name row set to
 *   `'new'` mints, once however many rows resolve to it.
 * - A row that stays `'new'` writes its resource as it is, plus its derived
 *   identifier and those of the id-only rows linked to it. A stored target
 *   gains its own derived identifier as well, so a name-and-birth-date match
 *   finds it next time and a second `apply` adds nothing.
 * - Every other resource comes back as the same object, the file keeps its
 *   sections and keys, and the stored resources' references are not touched.
 *
 * Pure and idempotent: applying the same map again changes nothing.
 */
const apply = (decodedFile: DecodedFile.DecodedFile, map: Type): DecodedFile.DecodedFile => {
  const rows = IdentityRow.discover(decodedFile)
  const index = rowIndex(rows)
  const resolvedRows = rows.map((row) => ({ row, resolved: resolveIn(map, index, row) }))
  const resolutions = new Map(
    resolvedRows.map(({ row, resolved }) => [IdentityRow.key(row), resolved])
  )
  /** The stored resource replacing `resource`, when its identity's row links one. */
  const replacementOf = (resource: Identity.IdentifiedResource): Option.Option<Target.Stored> =>
    pipe(
      Identity.ofResource(resource),
      Option.flatMapNullable((identity) => resolutions.get(Identity.key(identity))),
      Option.filter(Target.isStored)
    )

  // `Type/<source id>` → `Type/<stored id>`, for every source resource a stored one replaces,
  // including a second resource of the same identity under another id.
  const literalRepoints = new Map(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      Identity.isIdentifiedResource(resource)
        ? Option.toArray(
            Option.all([literalOfDecoded(resource), replacementOf(resource)]).pipe(
              Option.map(([from, { resource: to }]) => [from, literalOf(to)] as const)
            )
          )
        : []
    )
  )

  // What each target gains: a stored resource keyed by its literal, a `'new'` one by its row key.
  const taught = new Map<string, readonly IdentifierAndReference.IdentifierType[]>()
  const teach = (
    target: string,
    identifiers: readonly IdentifierAndReference.IdentifierType[]
  ): void => {
    taught.set(target, [...(taught.get(target) ?? []), ...identifiers])
  }
  /** What a target, by its `taught` key, gains; nothing for no key. */
  const gainedBy = (
    target: Option.Option<string>
  ): readonly IdentifierAndReference.IdentifierType[] =>
    Option.getOrElse(
      Option.flatMapNullable(target, (key) => taught.get(key)),
      () => []
    )
  // Every stored or minted target, in first-linked order, and whether only id-only rows link it.
  const linkTargets = new Map<string, { resource: Target.StoredResource; linkedOnly: boolean }>()
  for (const { row, resolved } of resolvedRows) {
    if (resolved === 'dontLink') continue
    if (resolved._tag === 'newFromRow') {
      teach(IdentityRow.key(resolved.row), taughtBy(row))
      continue
    }
    const target = literalOf(resolved.resource)
    const known = linkTargets.get(target)
    if (known === undefined) {
      teach(target, Option.toArray(IdentityRow.derivedIdentifier(resolved.resource)))
    }
    teach(target, taughtBy(row))
    linkTargets.set(target, {
      resource: resolved.resource,
      linkedOnly: (known?.linkedOnly ?? true) && row._tag === 'reference',
    })
  }
  const linkResources = new Map(
    [...linkTargets].map(([target, { resource }]) => [
      target,
      Identity.withIdentifiers(resource, taught.get(target) ?? []),
    ])
  )

  const repoint =
    (resource: FhirResource) =>
    (reference: IdentifierAndReference.ReferenceType): IdentifierAndReference.ReferenceType => {
      const literal =
        reference.reference === null
          ? pipe(
              ReferenceSlot.identityOf(resource, reference),
              Option.flatMap((identity) =>
                Option.fromNullable(resolutions.get(Identity.key(identity)))
              ),
              Option.flatMap(literalOfResolved)
            )
          : Option.fromNullable(literalRepoints.get(reference.reference))
      return Option.match(literal, {
        onNone: () => reference,
        onSome: (to) => ({ ...reference, reference: to }),
      })
    }
  const repointAll = (resource: FhirResource): FhirResource =>
    ResourceReferences.map(resource, repoint(resource))

  const filed = (resource: FhirResource): FhirResource => {
    if (!Identity.isIdentifiedResource(resource)) return repointAll(resource)
    const replacement = replacementOf(resource)
    if (Option.isSome(replacement)) {
      return linkResources.get(literalOf(replacement.value.resource)) ?? resource
    }
    // What it gains as a row's `'new'` resource, and as a copy of a stored
    // target the file already holds (as a re-apply's Linked section does).
    const gained = [
      ...gainedBy(Option.map(Identity.ofResource(resource), Identity.key)),
      ...gainedBy(literalOfDecoded(resource)),
    ]
    return repointAll(Identity.withIdentifiers(resource, gained))
  }

  const sections = decodedFile.sections.map((section) => {
    const resources = section.resources.map((entry) => {
      const resource = filed(entry.resource)
      return resource === entry.resource ? entry : { ...entry, resource }
    })
    return resources.every((entry, at) => entry === section.resources[at])
      ? section
      : { ...section, resources }
  })
  const held = new Set(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      Option.toArray(literalOfDecoded(resource))
    )
  )
  const linked = [...linkTargets]
    .filter(([target, { linkedOnly }]) => linkedOnly && !held.has(target))
    .flatMap(([target]) =>
      Option.toArray(Option.fromNullable(linkResources.get(target))).map((resource) => ({
        key: linkedKey(resource),
        title: IdentityRow.labelOf(resource, target),
        resource,
      }))
    )
  return linked.length === 0
    ? { ...decodedFile, sections }
    : {
        ...decodedFile,
        sections: [...sections, { title: LINKED_SECTION_TITLE, resources: linked }],
      }
}

/** Whether a slot's reference lands on a resource: a literal that is not an absolute URL. */
const isResolved = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && URL.parse(reference.reference) === null

/**
 * Whether an unresolved slot reference is one to list: any `subject`, and a
 * `requester` or `performer` with an absolute URL or an identity, as opposed to
 * a `display` alone.
 */
const needsLinking = (
  resource: FhirResource,
  field: ReferenceSlot.Field,
  reference: IdentifierAndReference.ReferenceType
): boolean =>
  field === 'subject' ||
  reference.reference !== null ||
  Option.isSome(ReferenceSlot.identityOf(resource, reference))

/**
 * Every `subject`, `requester` and `performer` the map leaves on no resource,
 * once `apply` has run: an unmapped or `'dontLink'` identity, an absolute URL,
 * or a missing `subject` on a type that carries one.
 *
 * @remarks
 * A `subject` resolves only through a relative literal, so every
 * subject-bearing resource with none is listed. A `requester` or `performer`
 * that names no identity at all (a `display`-only lab) is not: it is not a
 * person the map could link. The path is the slot's, read by field
 * (`ReferenceSlot`), since `ResourceReferences.map` reports none.
 */
const unresolved = (decodedFile: DecodedFile.DecodedFile, map: Type): readonly Unresolved[] =>
  DecodedFile.resources(apply(decodedFile, map)).flatMap(({ key, resource }) => {
    const missingSubject =
      'subject' in resource && resource.subject === null
        ? [{ reviewKey: key, path: 'subject', reference: null }]
        : []
    const unlanded = ReferenceSlot.of(resource)
      .filter(
        ({ field, reference }) => !isResolved(reference) && needsLinking(resource, field, reference)
      )
      .map(({ path, reference }) => ({ reviewKey: key, path, reference }))
    return [...missingSubject, ...unlanded]
  })

export { LINKED_SECTION_TITLE, apply, linkedKey, resolve, targetOf, unresolved }
export type { Type, Unresolved }

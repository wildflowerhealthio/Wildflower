import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Grant, Scope } from '@wildflowerhealthio/scopes-core'
import { Array, Match } from 'effect'

/**
 * What the sign-in's grant lets the assistant do with the record: which
 * resource types it may read, search and write. The grant decides, not the
 * scope the app asked for.
 *
 * @remarks
 * A namespace module: `RecordAccess.Type`, `RecordAccess.ResourceTypes`,
 * `RecordAccess.fromGrantedScopes`, `RecordAccess.typesOf`,
 * `RecordAccess.paragraphOf`. Only FHIR resource scopes count, in any
 * context (`patient/`, `user/`, `system/`): the server holds each request to
 * its own context. A `*` resource type is every type.
 *
 * @packageDocumentation
 */

/** Every resource type, or the named ones (none when the list is empty). */
type ResourceTypes =
  | { readonly kind: 'every-type' }
  | { readonly kind: 'named-types'; readonly types: readonly ResourceType.Type[] }

/** The resource types the grant covers for each kind of access. */
interface Type {
  /** Read one record by id (`r`). */
  readonly readable: ResourceTypes
  /** Search for records (`s`). */
  readonly searchable: ResourceTypes
  /** Create or update records (`c` or `u`). */
  readonly writable: ResourceTypes
}

/** A SMART v2 interaction letter, and the SMART v1 word that grants it. */
const V1_WORD_OF = { r: 'read', s: 'read', c: 'write', u: 'write' } as const

type Interaction = keyof typeof V1_WORD_OF

const FHIR_CONTEXTS = ['patient', 'user', 'system'] as const

/**
 * Whether `granted` covers `interaction` on `resourceType` (a type, or `*`)
 * in some FHIR context, asked of `scopes-core` as both the v2 letter and the
 * v1 word, since neither style covers a request in the other.
 */
const grantCovers = (
  granted: Grant.Grant,
  resourceType: string,
  interaction: Interaction
): boolean =>
  FHIR_CONTEXTS.some((context) =>
    [interaction, V1_WORD_OF[interaction]].some((permission) =>
      Scope.MultiScope.within(Grant.parse([`${context}/${resourceType}.${permission}`]), granted)
    )
  )

/** The resource types `granted` covers for any of `interactions`. */
const resourceTypesCovering = (
  granted: Grant.Grant,
  namedTypes: readonly ResourceType.Type[],
  interactions: readonly Interaction[]
): ResourceTypes =>
  interactions.some((interaction) => grantCovers(granted, '*', interaction))
    ? { kind: 'every-type' }
    : {
        kind: 'named-types',
        types: namedTypes.filter((resourceType) =>
          interactions.some((interaction) => grantCovers(granted, resourceType, interaction))
        ),
      }

/**
 * What `grantedScopes` (a `SmartConnection`'s) let the assistant do. A named
 * type outside FHIR R4's resource types is left out: nothing can be asked of
 * it.
 */
const fromGrantedScopes = (grantedScopes: readonly Scope.Any[]): Type => {
  const granted = Grant.make(grantedScopes)
  const namedTypes = Array.dedupe(
    Array.filter(
      Scope.MultiScope.fhirScopes(granted).map((scope) => scope.resource.serialize()),
      ResourceType.is
    )
  ).toSorted()
  return {
    readable: resourceTypesCovering(granted, namedTypes, ['r']),
    searchable: resourceTypesCovering(granted, namedTypes, ['s']),
    writable: resourceTypesCovering(granted, namedTypes, ['c', 'u']),
  }
}

/** `resourceTypes` as a list: every R4 resource type for `every-type`. */
const typesOf = (resourceTypes: ResourceTypes): readonly ResourceType.Type[] =>
  Match.value(resourceTypes).pipe(
    Match.when({ kind: 'every-type' }, () => ResourceType.VALUES),
    Match.when({ kind: 'named-types' }, ({ types }) => types),
    Match.exhaustive
  )

/** The types the assistant can read either way, by id or by search. */
const readableOrSearchableOf = (access: Type): ResourceTypes =>
  access.readable.kind === 'every-type' || access.searchable.kind === 'every-type'
    ? { kind: 'every-type' }
    : {
        kind: 'named-types',
        types: Array.union(access.readable.types, access.searchable.types).toSorted(),
      }

/**
 * What the assistant can do with the record, in words, for the system
 * prompt: the types it can read, and that it can't create or change records,
 * since it has no tools that write.
 */
const paragraphOf = (access: Type): string => {
  const readSentence = Match.value(readableOrSearchableOf(access)).pipe(
    Match.when({ kind: 'every-type' }, () => 'You can read every record type.'),
    Match.when({ kind: 'named-types' }, ({ types }) =>
      types.length === 0
        ? "You can't read any records: the person didn't grant this app access to them. If they ask about their record, say so, and help with what they tell you."
        : `You can read these record types and no others: ${types.join(', ')}.`
    ),
    Match.exhaustive
  )
  return `${readSentence} You can't create or change records.`
}

export { fromGrantedScopes, paragraphOf, typesOf }
export type { ResourceTypes, Type }

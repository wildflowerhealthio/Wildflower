/**
 * Compare to stored: the gap rule, what an import resource offers a stored
 * record, top-level field by top-level field.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { diffJson, IdentifierUnion, normalizedFieldsOf } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashSet, Option, type Record } from 'effect'

import type * as OfferedFields from '../../entities/offered-fields.ts'
import * as ComparableReferences from './comparable-references.ts'

/** The top-level wire keys that are no field a reviewer takes. */
const NOT_OFFERED: ReadonlySet<string> = new Set(['resourceType', 'id', 'meta', 'identifier'])

/**
 * `resource`'s top-level fields, as `normalizedEncode` writes them.
 *
 * @throws When `resource` does not encode through its own schema. Every
 *   resource here was decoded by that schema, so that is a defect.
 */
const fieldsOf = (resource: FhirResource): Record.ReadonlyRecord<string, unknown> =>
  Option.getOrThrowWith(
    normalizedFieldsOf(resource),
    () => new Error(`A decoded ${resource.resourceType} does not encode through its schema`)
  )

/** Whether a wire value says something: neither absent nor an empty list. */
const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)

/**
 * What `resource` offers `stored`: the top-level fields that differ between
 * them (`diffJson`) and that the import has a value for, in the import's
 * field order, each filling a gap when `stored` has no value for it and
 * overwriting one otherwise; and the import's qualified identifiers `stored`
 * does not carry.
 *
 * @param resource - The import resource
 * @param stored - The stored record it would be written into, as it stands
 * @param comparable - How the references of both are compared
 *   (`ComparableReferences`): by what they name, not by their literal
 */
const compareToStored = (
  resource: FhirResource,
  stored: FhirResource,
  comparable: ComparableReferences.Type
): OfferedFields.Type => {
  const incoming = fieldsOf(ComparableReferences.comparableResourceOf(comparable, resource))
  const existing = fieldsOf(ComparableReferences.comparableResourceOf(comparable, stored))
  const differing = HashSet.fromIterable(
    diffJson(existing, incoming).flatMap(({ path: [field] }) =>
      typeof field === 'string' ? [field] : []
    )
  )
  const [gapFilling, overwriting] = Arr.partition(
    Object.keys(incoming).filter(
      (field) =>
        HashSet.has(differing, field) && !NOT_OFFERED.has(field) && hasValue(incoming[field])
    ),
    (field) => hasValue(existing[field])
  )
  return {
    gapFilling,
    overwriting,
    identifiersToAdd: IdentifierUnion.missingFrom(
      DetachedResource.hasIdentifier(stored) ? stored.identifier : [],
      resource
    ),
  }
}

export { compareToStored }

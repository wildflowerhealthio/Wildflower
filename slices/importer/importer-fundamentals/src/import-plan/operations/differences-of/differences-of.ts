/**
 * Differences of: the gap rule, what an incoming record offers the record it
 * merges into, the kept one, top-level field by top-level field.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { diffJson, IdentifierUnion, normalizedFieldsOf } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, HashSet, Option, type Record } from 'effect'

import * as OfferedFields from '../../entities/offered-fields.ts'
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
 * What `incoming` offers `kept`: the top-level fields that differ between
 * them (`diffJson`) and that the incoming record has a value for, in its
 * field order, each filling a gap when `kept` has no value for it and
 * overwriting one otherwise; and the incoming record's qualified identifiers
 * `kept` does not carry.
 *
 * @param incoming - The imported record merged in
 * @param kept - The record it merges into, as it stands
 * @param comparable - How the references of both are compared
 *   (`ComparableReferences`): by what they name, not by their literal
 */
const differencesOf = (
  incoming: FhirResource,
  kept: FhirResource,
  comparable: ComparableReferences.Type
): OfferedFields.Type => {
  const incomingFields = fieldsOf(ComparableReferences.comparableResourceOf(comparable, incoming))
  const keptFields = fieldsOf(ComparableReferences.comparableResourceOf(comparable, kept))
  const differing = HashSet.fromIterable(
    diffJson(keptFields, incomingFields).flatMap(({ path: [field] }) =>
      typeof field === 'string' ? [field] : []
    )
  )
  const [gapFilling, overwriting] = Arr.partition(
    Object.keys(incomingFields).filter(
      (field) =>
        HashSet.has(differing, field) && !NOT_OFFERED.has(field) && hasValue(incomingFields[field])
    ),
    (field) => hasValue(keptFields[field])
  )
  return OfferedFields.make({
    gapFilling,
    overwriting,
    identifiersToAdd: IdentifierUnion.missingFrom(
      DetachedResource.hasIdentifier(kept) ? kept.identifier : [],
      incoming
    ),
  })
}

export { differencesOf }

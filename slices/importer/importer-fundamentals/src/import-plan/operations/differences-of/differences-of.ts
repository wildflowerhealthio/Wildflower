/**
 * Differences of: the top-level fields where an incoming record says
 * something other than the record it merges into, the kept one.
 *
 * @packageDocumentation
 */
import { diffJson, normalizedFieldsOf } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option, type Record } from 'effect'

import * as Difference from '../../entities/difference.ts'
import * as ComparableReferences from './comparable-references.ts'

/**
 * The top-level wire keys that are never a difference: no field a reviewer
 * takes.
 *
 * @remarks
 * `text` is the narrative written for the resource it sits in. Taken into
 * another record it would describe fields that record does not hold.
 */
const NEVER_A_DIFFERENCE: ReadonlySet<string> = new Set([
  'resourceType',
  'id',
  'meta',
  'identifier',
  'text',
])

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
 * The differences of `incoming` from `kept`: each top-level field that
 * differs between them (`diffJson`) and that `incoming` has a value for, in
 * the order `incoming`'s schema encodes its fields, filling a gap when
 * `kept` has no value for it and overwriting one otherwise.
 *
 * @param incoming - The imported record merged in
 * @param kept - The record it merges into, as it stands
 * @param comparable - How the references of both are compared
 *   (`ComparableReferences`): by what they name, not by their literal
 *
 * @remarks
 * `resourceType`, `id`, `meta`, `identifier` and `text` are never a
 * difference. The identifiers a merge adds are those `kept` lacks
 * (`IdentifierUnion.missingFrom`), whatever the differences are.
 */
const differencesOf = (
  incoming: FhirResource,
  kept: FhirResource,
  comparable: ComparableReferences.Type
): readonly Difference.Type[] => {
  const incomingFields = fieldsOf(ComparableReferences.comparableResourceOf(comparable, incoming))
  const keptFields = fieldsOf(ComparableReferences.comparableResourceOf(comparable, kept))
  const differing = HashSet.fromIterable(
    diffJson(keptFields, incomingFields).flatMap(({ path: [field] }) =>
      typeof field === 'string' ? [field] : []
    )
  )
  return Object.keys(incomingFields)
    .filter(
      (field) =>
        HashSet.has(differing, field) &&
        !NEVER_A_DIFFERENCE.has(field) &&
        hasValue(incomingFields[field])
    )
    .map((field) =>
      hasValue(keptFields[field])
        ? Difference.Overwrites({ field })
        : Difference.FillsGap({ field })
    )
}

export { differencesOf }

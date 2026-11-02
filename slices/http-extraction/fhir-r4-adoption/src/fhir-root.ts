import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'

/**
 * A FHIR server's root (`https://example.com/fhir`), and the two rules that
 * follow from a source being one.
 *
 * @remarks
 * A FHIR server's ids are unique per type, so the system its `resourceType`
 * ids belong to is `<root>/<Type>` ({@link systemFor}); and it may spell a
 * reference to its own record absolutely under the root, which is the same
 * target as the relative `Type/id` ({@link relativise}).
 */

/** The system a FHIR server's `resourceType` ids belong to: `<root>/<Type>`. */
const systemFor = (root: string, resourceType: string): string => `${root}/${resourceType}`

/**
 * `reference` with the server's absolute spelling of its own record,
 * `<root>/Type/id`, read back to the relative `Type/id`; any other reference
 * as it is.
 */
const relativise =
  (root: string) =>
  (reference: ReferenceType): ReferenceType =>
    reference.reference?.startsWith(`${root}/`) === true
      ? { ...reference, reference: reference.reference.slice(root.length + 1) }
      : reference

export { relativise, systemFor }

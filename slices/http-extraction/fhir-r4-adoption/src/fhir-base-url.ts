import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'

/**
 * A FHIR server's base URL (`https://example.com/fhir`, the `[base]` of
 * `[base]/[type]/[id]`), and the two rules that follow from it.
 *
 * @remarks
 * A FHIR server's ids are unique per type, so the system its `resourceType`
 * ids belong to is `<baseUrl>/<Type>` ({@link systemFor}); and it may spell a
 * reference to its own record absolutely under the base, which is the same
 * target as the relative `Type/id` ({@link relativise}).
 */

/** The system a FHIR server's `resourceType` ids belong to: `<baseUrl>/<Type>`. */
const systemFor = (baseUrl: string, resourceType: string): string => `${baseUrl}/${resourceType}`

/**
 * `reference` with the server's absolute spelling of its own record,
 * `<baseUrl>/Type/id`, read back to the relative `Type/id`; any other
 * reference as it is.
 */
const relativise =
  (baseUrl: string) =>
  (reference: ReferenceType): ReferenceType =>
    reference.reference?.startsWith(`${baseUrl}/`) === true
      ? { ...reference, reference: reference.reference.slice(baseUrl.length + 1) }
      : reference

export { relativise, systemFor }

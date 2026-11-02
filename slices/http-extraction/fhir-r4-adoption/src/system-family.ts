import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { Data, Function } from 'effect'

/**
 * A family of identifier systems: how the `Identifier.system` of a record's
 * source id, the namespace its value is unique in, is chosen for each
 * resource type in one context, such as a source's batch.
 *
 * @remarks
 * A record is keyed by (system, resource type, source id). Its local id is
 * `localResourceId` of that key, and its source identifier is
 * `{ system, value: <source id> }`, so every system is an absolute URI that
 * `new URL` accepts.
 *
 * - `FixedAcrossResourceTypes`: one `system` whatever the type. A portal's
 *   Wildflower-minted `…/fhir/sid/<source>` URI, or a format's coding system
 *   for a picked source file.
 * - `FhirStyleBaseUrl`: the type appended to `baseUrl`, so a `Patient`'s
 *   system is `<baseUrl>/Patient`, the `[base]/[type]` of a FHIR server's
 *   `[base]/[type]/[id]`. A FHIR server's ids are unique per type, which is
 *   why.
 *
 * Structurally `http-extraction-fundamentals`' `RecognizedUrlData.systemFamily`,
 * which stays FHIR-free: each response kind's `tryRecognize` mints one of
 * these, and adoption reads it as its own.
 */
type Type = Data.TaggedEnum<{
  FixedAcrossResourceTypes: { readonly system: string }
  FhirStyleBaseUrl: { readonly baseUrl: string }
}>

const { FixedAcrossResourceTypes, FhirStyleBaseUrl, $match } = Data.taggedEnum<Type>()

/** The system `family` gives `resourceType`: where a record, or a reference's target, of that type is keyed. */
const systemFor = (family: Type, resourceType: string): string =>
  $match(family, {
    FixedAcrossResourceTypes: ({ system }) => system,
    FhirStyleBaseUrl: ({ baseUrl }) => `${baseUrl}/${resourceType}`,
  })

/**
 * `reference` as the relative `Type/id` adoption rewrites, for one family;
 * any other reference as it is.
 *
 * @remarks
 * A FHIR server may spell a reference to its own record absolutely,
 * `<baseUrl>/Type/id`, which is the same target as `Type/id`, so under
 * `FhirStyleBaseUrl` that prefix is read back off. A fixed system has no
 * absolute spelling of its own, so under `FixedAcrossResourceTypes` every
 * reference is already as relative as it will be.
 */
const relativise = (family: Type): ((reference: ReferenceType) => ReferenceType) =>
  $match(family, {
    FixedAcrossResourceTypes: () => Function.identity,
    FhirStyleBaseUrl:
      ({ baseUrl }) =>
      (reference: ReferenceType) =>
        reference.reference?.startsWith(`${baseUrl}/`) === true
          ? { ...reference, reference: reference.reference.slice(baseUrl.length + 1) }
          : reference,
  })

export { $match, FhirStyleBaseUrl, FixedAcrossResourceTypes, relativise, systemFor }
export type { Type }

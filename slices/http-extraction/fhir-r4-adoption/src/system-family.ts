import { Data } from 'effect'

import * as FhirBaseUrl from './fhir-base-url.ts'

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
 * - `FhirStyleBaseUrl`: the type is appended to `baseUrl`, so a `Patient`'s
 *   system is `<baseUrl>/Patient` ({@link FhirBaseUrl.systemFor}). A FHIR
 *   server's ids are unique per type, which is why.
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
    FhirStyleBaseUrl: ({ baseUrl }) => FhirBaseUrl.systemFor(baseUrl, resourceType),
  })

export { $match, FhirStyleBaseUrl, FixedAcrossResourceTypes, systemFor }
export type { Type }

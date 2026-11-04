import { Data, Function } from 'effect'

/**
 * A family of identifier systems: how the `Identifier.system` a source's id
 * for a record belongs to, the namespace that id is unique in, is chosen for
 * each resource type in one context, such as a source's response.
 *
 * @remarks
 * A record's key is `{ system, value: <the source's id> }`, so every system is
 * an absolute URI that `new URL` accepts. Each response kind's `tryRecognize`
 * mints one of these as `RecognizedUrlData.systemFamily`, and
 * `fhir-r4-adoption`'s `detach` reads it once, as it detaches what the kind
 * decoded; nothing downstream of that carries it.
 *
 * - `FixedAcrossResourceTypes`: one `system` whatever the type. A portal's
 *   Wildflower-minted `…/fhir/sid/<source>` URI, or a format's coding system
 *   for a picked source file.
 * - `FhirStyleBaseUrl`: the type appended to `baseUrl`, so a `Patient`'s
 *   system is `<baseUrl>/Patient`, the `[base]/[type]` of a FHIR server's
 *   `[base]/[type]/[id]`. A FHIR server's ids are unique per type, which is
 *   why.
 * - `SystemPerResourceType`: the system a source publishes for each type it
 *   names, listed in `systems` by resource type: a portal whose ids each
 *   belong to a namespace of its own (Shoppers' `patient-id`, `dispense-id`).
 *   A type the list leaves out has no system ({@link systemFor}).
 */
type Type = Data.TaggedEnum<{
  FixedAcrossResourceTypes: { readonly system: string }
  FhirStyleBaseUrl: { readonly baseUrl: string }
  SystemPerResourceType: { readonly systems: Readonly<Record<string, string>> }
}>

const { FixedAcrossResourceTypes, FhirStyleBaseUrl, SystemPerResourceType, $match } =
  Data.taggedEnum<Type>()

/**
 * The system `family` gives `resourceType`: the namespace a source's id for a
 * record, or for a reference's target, of that type belongs to.
 *
 * @remarks
 * Throws for a type a `SystemPerResourceType` family does not list. That is a
 * misconfigured source, a kind naming a type its family was never told about,
 * not bad data in a response, so it surfaces as a defect rather than as a
 * typed failure a caller could fold into an outcome.
 */
const systemFor = (family: Type, resourceType: string): string =>
  $match(family, {
    FixedAcrossResourceTypes: ({ system }) => system,
    FhirStyleBaseUrl: ({ baseUrl }) => `${baseUrl}/${resourceType}`,
    SystemPerResourceType: ({ systems }) => {
      const system = systems[resourceType]
      if (system === undefined) {
        throw new Error(`SystemFamily.systemFor: this family lists no system for ${resourceType}`)
      }
      return system
    },
  })

/**
 * A reference literal as the relative `Type/id` `detach` reads a target's id
 * from, for one family; any other literal as it is.
 *
 * @remarks
 * A FHIR server may spell a reference to its own record absolutely,
 * `<baseUrl>/Type/id`, which is the same target as `Type/id`, so under
 * `FhirStyleBaseUrl` that prefix is read back off. A portal's systems are
 * namespaces, not addresses, so it has no absolute spelling of its own: under
 * `FixedAcrossResourceTypes` and `SystemPerResourceType` every literal is
 * already as relative as it will be.
 */
const relativise = (family: Type): ((reference: string) => string) =>
  $match(family, {
    FixedAcrossResourceTypes: () => Function.identity,
    SystemPerResourceType: () => Function.identity,
    FhirStyleBaseUrl:
      ({ baseUrl }) =>
      (reference: string) =>
        reference.startsWith(`${baseUrl}/`) ? reference.slice(baseUrl.length + 1) : reference,
  })

export {
  $match,
  FhirStyleBaseUrl,
  FixedAcrossResourceTypes,
  relativise,
  systemFor,
  SystemPerResourceType,
}
export type { Type }

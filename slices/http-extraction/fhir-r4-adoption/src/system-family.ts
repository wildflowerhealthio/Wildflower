import { Data, Function } from 'effect'

/**
 * The identifier systems a record a server served is keyed in, per resource
 * type: the namespace each of that server's ids is unique in, which is what
 * `detach` reads to turn the server's ids into keys.
 *
 * @remarks
 * A record's key is `{ system, value: <the server's id> }`, so every system is
 * an absolute URI that `new URL` accepts. Only a response kind whose records
 * really were a server's, ids and literal references included, detaches
 * under one, privately, in its own `parse`; every other decoder writes its
 * records detached already and names no family.
 *
 * - `FixedAcrossResourceTypes`: one `system` whatever the type. Carebook's
 *   Wildflower-minted `…/fhir/sid/rexall-carebook` URI.
 * - `FhirStyleBaseUrl`: the type appended to `baseUrl`, so a `Patient`'s
 *   system is `<baseUrl>/Patient`, the `[base]/[type]` of a FHIR server's
 *   `[base]/[type]/[id]`. A FHIR server's ids are unique per type, which is
 *   why; its base is also the prefix of its absolute spelling of a reference
 *   to its own record ({@link relativise}), so the one value says both.
 */
type Type = Data.TaggedEnum<{
  FixedAcrossResourceTypes: { readonly system: string }
  FhirStyleBaseUrl: { readonly baseUrl: string }
}>

const { FixedAcrossResourceTypes, FhirStyleBaseUrl, $match } = Data.taggedEnum<Type>()

/**
 * The system `family` gives `resourceType`: the namespace a server's id for a
 * record, or for a reference's target, of that type belongs to.
 */
const systemFor = (family: Type, resourceType: string): string =>
  $match(family, {
    FixedAcrossResourceTypes: ({ system }) => system,
    FhirStyleBaseUrl: ({ baseUrl }) => `${baseUrl}/${resourceType}`,
  })

/**
 * A reference literal as the relative `Type/id` `detach` reads a target's id
 * from, for one family; any other literal as it is.
 *
 * @remarks
 * A FHIR server may spell a reference to its own record absolutely,
 * `<baseUrl>/Type/id`, which is the same target as `Type/id`, so under
 * `FhirStyleBaseUrl` that prefix is read back off. A fixed system is a
 * namespace, not an address, so it has no absolute spelling of its own: under
 * `FixedAcrossResourceTypes` every literal is already as relative as it will
 * be.
 */
const relativise = (family: Type): ((reference: string) => string) =>
  $match(family, {
    FixedAcrossResourceTypes: () => Function.identity,
    FhirStyleBaseUrl:
      ({ baseUrl }) =>
      (reference: string) =>
        reference.startsWith(`${baseUrl}/`) ? reference.slice(baseUrl.length + 1) : reference,
  })

export { $match, FhirStyleBaseUrl, FixedAcrossResourceTypes, relativise, systemFor }
export type { Type }

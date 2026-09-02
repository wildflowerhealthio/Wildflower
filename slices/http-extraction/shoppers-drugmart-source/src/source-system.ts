/**
 * The source system every resource this source imports is keyed under — a
 * Wildflower-minted `sid` URI naming the portal (not one of `shoppers.ts`'s
 * per-field identifier systems). **Persisted wire format:** the hash domain for
 * every derived local id and the `Identifier.system` beside every source id, so
 * changing it orphans everything already imported. Its own leaf module (not
 * `source.ts`) to break the `source.ts` ⇄ response-kinds import cycle.
 */
const SHOPPERS_DRUGMART_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'

export { SHOPPERS_DRUGMART_SYSTEM }

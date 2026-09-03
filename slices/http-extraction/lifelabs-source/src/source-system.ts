/**
 * The source system every resource this source imports is keyed under — a
 * Wildflower-minted `sid` URI naming the LifeLabs MyCareCompass portal (not one
 * of `lifelabs.ts`'s per-field identifier/coding systems). **Persisted wire
 * format:** the hash domain for every derived local id and the
 * `Identifier.system` beside every source id, so changing it orphans everything
 * already imported. Its own leaf module (not `source.ts`) to break the
 * `source.ts` ⇄ response-kinds import cycle.
 */
const LIFELABS_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/lifelabs'

export { LIFELABS_SYSTEM }

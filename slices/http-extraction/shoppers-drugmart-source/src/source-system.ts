/**
 * The source system every resource this source imports is keyed under.
 *
 * @remarks
 * A Wildflower-minted `sid` URI naming the Shoppers "mypharmacy" portal as an
 * import source, in the same style as `rexall-be-well-source`'s
 * `REXALL_CAREBOOK_SYSTEM`. It is deliberately *not* one of `shoppers.ts`'s
 * per-field identifier systems (`SYSTEM_BASE`/`ShoppersIdentifierSystem`): those
 * name what a *field value* means (a `pcId`, a `patientId`), whereas this names
 * the *portal the whole resource came from* — the hash domain and the injected
 * `Identifier.system`.
 *
 * **Persisted wire format.** It is the hash domain for every derived local id
 * and the `Identifier.system` written beside every source id, so changing it
 * orphans everything already imported from Shoppers Drug Mart.
 *
 * Its own leaf module (not `source.ts`) so the response kinds can read it for
 * their `tryRecognize` `source.system` without importing `source.ts`, which
 * imports *them* — the split breaks that cycle.
 */
const SHOPPERS_DRUGMART_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'

export { SHOPPERS_DRUGMART_SYSTEM }

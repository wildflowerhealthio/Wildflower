/**
 * The source system every resource this collector imports is keyed under.
 *
 * @remarks
 * A Wildflower-minted `sid` URI in the same style as `web-trace`'s systems, not
 * a carebook dialect constant — carebook publishes no namespace for "the id this
 * portal gave a resource", so this names the portal on its behalf. It does not
 * belong in `carebook.ts` for that reason.
 *
 * **Persisted wire format.** It is the hash domain for every derived local id
 * and the `Identifier.system` written beside every carebook id, so changing it
 * orphans everything already imported from Rexall.
 *
 * Its own leaf module (not `config.ts`) so the response kinds can read it for
 * their `tryRecognize` `source.system` without importing `config.ts`, which
 * imports *them* — the split breaks that cycle.
 */
const REXALL_CAREBOOK_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/rexall-carebook'

export { REXALL_CAREBOOK_SYSTEM }

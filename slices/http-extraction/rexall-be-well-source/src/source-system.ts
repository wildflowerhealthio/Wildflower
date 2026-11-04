/**
 * The system every carebook id this source reads belongs to, whatever the
 * resource type: the namespace of each record's key.
 *
 * @remarks
 * A Wildflower-minted `sid` URI in the same style as `web-trace`'s systems, not
 * a carebook dialect constant — carebook publishes no namespace for "the id this
 * portal gave a resource", so this names the portal on its behalf. It does not
 * belong in `carebook.ts` for that reason.
 *
 * **Persisted wire format.** It is the system of every Rexall record's key,
 * `identifier[0]`, and so the hash domain of every id a Rexall import stores
 * under; changing it orphans everything already imported from Rexall.
 *
 * Its own leaf module (not `source.ts`) so the response kinds can read it
 * without importing `source.ts`, which imports *them* — the split breaks that
 * cycle.
 */
const REXALL_CAREBOOK_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/rexall-carebook'

export { REXALL_CAREBOOK_SYSTEM }

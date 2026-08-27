/**
 * The cross-source specificity ranking every {@link HttpResponseKind} scores
 * its claim against — the convention the deleted `Source` value used to hold in
 * its doc comment, now exported tier constants each source package imports.
 *
 * @remarks
 * A response kind's `tryRecognize` returns a `specificity` number, and routing
 * is **highest wins** (`Extraction.routeTo` / `Extraction.recognize`). These
 * are the tiers that number is drawn from — a plain, ordered convention across
 * sources rather than an enum this package polices, so a new kind of source
 * needs no change here:
 *
 * - **`PORTAL`** (100) — a named patient portal (Rexall, Shoppers): the most
 *   specific claim, so a portal capture is never mistaken for a bare FHIR
 *   server.
 * - **`PROTOCOL`** (50) — any FHIR R4 server: the protocol-generic middle rung.
 * - **`CATCH_ALL`** (0) — a recorder that claims everything (web-trace): wins
 *   only when nothing more specific decodes the traffic.
 *
 * Higher wins, with room left between the tiers so a future portal or a second
 * protocol slots in without renumbering. Values chosen so today's FHIR sits at
 * the mid rung (was `Source`'s `FHIR_R4_SPECIFICITY = 50`).
 *
 * Import callers use the file as a namespace:
 * `import { Specificity } from 'http-extraction-fundamentals'` →
 * `Specificity.PORTAL`.
 */
const Specificity = {
  /** A named patient portal — the most specific claim. */
  PORTAL: 100,
  /** Any FHIR R4 server — the protocol-generic middle rung. */
  PROTOCOL: 50,
  /** A recorder that claims everything — wins only when nothing else does. */
  CATCH_ALL: 0,
} as const

export { Specificity }

/**
 * The HAR importer's per-import settings — none today.
 *
 * @remarks
 * An empty record rather than a phantom flag: the settings seam a future format
 * needs stays present without inventing a setting HAR does not have. A field
 * lands here the day the HAR import grows one (a redaction toggle, a root
 * allowlist).
 */
interface HarSettings {}

/** The default (empty) HAR settings. */
const defaultHarSettings: HarSettings = {}

export { defaultHarSettings }
export type { HarSettings }

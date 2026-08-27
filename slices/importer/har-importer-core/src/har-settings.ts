/**
 * The HAR importer's per-import settings — none today.
 *
 * @remarks
 * A HAR archive is decoded and recognized with no user-tunable knobs, so the
 * settings are an empty record rather than a phantom flag: the descriptor still
 * carries a `defaultSettings` and the shell still renders a (no-op)
 * `SettingsPicker`, so the seam a future format needs is present without
 * inventing a setting HAR does not have. A field lands here the day the HAR
 * import grows one (a redaction toggle, a root allowlist).
 */
interface HarSettings {}

/** The default (empty) HAR settings. */
const defaultHarSettings: HarSettings = {}

export { defaultHarSettings }
export type { HarSettings }

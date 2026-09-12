/**
 * The HAR importer's per-import settings: which response kinds to leave out.
 *
 * @remarks
 * The one knob the format has. Recognition still runs against the whole pool;
 * a disabled kind's responses decode to a note instead of resources, so the
 * reviewer sees what the toggle excluded. Stored as the *disabled* list so the
 * default is the empty array and a newly registered kind is on by default.
 */
interface HarSettings {
  /**
   * The kind names (`HttpResponseKind.name`) turned off for this import; a
   * kind absent here is enabled. Names rather than kind objects so the value
   * stays a serializable settings record.
   */
  readonly disabledKinds: readonly string[]
}

/** The default HAR settings: every registered kind enabled. */
const defaultHarSettings: HarSettings = { disabledKinds: [] }

export { defaultHarSettings }
export type { HarSettings }

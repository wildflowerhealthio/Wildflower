/**
 * The LifeLabs PDF importer's per-import settings.
 *
 * @remarks
 * The one knob the format needs: a LifeLabs report prints every timestamp in
 * the laboratory's local clock with no zone (`Aug 13 2026 13:02`), and FHIR's
 * `dateTime`-with-time and `instant` both require one. The report cannot say
 * which zone it was printed in — LifeLabs operates in Ontario and British
 * Columbia — so the importer asks.
 */
interface LifeLabsPdfSettings {
  /** The IANA time zone the report's printed clock is in. */
  readonly timeZone: string
}

/** The default settings: Toronto's zone, where the reports this binding was built from are from. */
const defaultLifeLabsPdfSettings: LifeLabsPdfSettings = { timeZone: 'America/Toronto' }

export { defaultLifeLabsPdfSettings }
export type { LifeLabsPdfSettings }

import type { HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'

/**
 * The LifeLabs PDF importer's per-import settings.
 *
 * @remarks
 * Two things the report does not say. It prints every timestamp in the
 * laboratory's local clock with no zone (`Aug 13 2026 13:02`), and FHIR's
 * `dateTime`-with-time and `instant` both require one. It prints the patient's
 * health card number (`HC #`) but not which province issued the card, only the
 * lab's address. LifeLabs operates in Ontario and British Columbia, so the
 * importer asks for both.
 */
interface LifeLabsPdfSettings {
  /** The IANA time zone the report's printed clock is in. */
  readonly timeZone: string
  /** The province that issued the health card whose number the report prints as `HC #`. */
  readonly healthCardProvince: HealthCardProvince.Type
}

/**
 * The default settings: Toronto's zone and Ontario's health card, where the
 * reports this binding was built from are from.
 */
const defaultLifeLabsPdfSettings: LifeLabsPdfSettings = {
  timeZone: 'America/Toronto',
  healthCardProvince: 'ON',
}

export { defaultLifeLabsPdfSettings }
export type { LifeLabsPdfSettings }

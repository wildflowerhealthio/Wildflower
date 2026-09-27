// Types for settings.js: its JSDoc and test/settings.test.ts read them. The
// Pebble bundle only picks up *.js and *.json, so this file never reaches the
// phone.

/** The settings as the configuration page saves them. */
interface Settings {
  readonly patientId: string
  readonly patientName: string | null
  readonly patientBirthDate: string | null
  readonly accessToken: string
  readonly fhirBaseUrl: string
}

/** The AppMessage dictionary the watch receives, keyed by `messageKeys` name. */
interface WatchMessage {
  readonly PatientName: string
  readonly PatientBirthDate: string
  /** Unix seconds. */
  readonly AuthTime: number
}

declare const STORAGE_KEY: string
declare function decodeResponse(response: string): Settings
declare function decodeStored(stored: string | null): Settings
declare function toWatchMessage(settings: Settings, receivedAtMs: number): WatchMessage

export { decodeResponse, decodeStored, STORAGE_KEY, toWatchMessage }
export type { Settings, WatchMessage }

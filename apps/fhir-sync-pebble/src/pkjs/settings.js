// The settings the configuration page (apps/fhir-sync-pebble-web) hands back,
// and the part of them the watch receives. Kept free of the Pebble globals so
// test/settings.test.ts can load it under Node. Written as ES5 CommonJS, which
// every PebbleKit JS runtime accepts.

/** Where index.js keeps the full settings, access token included, on the phone. */
var STORAGE_KEY = 'settings'

/**
 * @param {object} value
 * @param {string} key
 * @returns {string}
 */
function requireNonEmptyString(value, key) {
  /** @type {unknown} */
  var field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('Settings field ' + key + ' must be a non-empty string')
  }
  return field
}

/**
 * @param {object} value
 * @param {string} key
 * @returns {string | null}
 */
function requireStringOrNull(value, key) {
  /** @type {unknown} */
  var field = value[key]
  if (field !== null && typeof field !== 'string') {
    throw new Error('Settings field ' + key + ' must be a string or null')
  }
  return field
}

/**
 * Decodes parsed settings JSON, keeping only the fields the settings carry.
 * Throws when the value is not that shape.
 *
 * @param {unknown} value
 * @returns {import('./settings.js').Settings}
 */
function decodeSettings(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Settings must be a JSON object')
  }
  return {
    patientId: requireNonEmptyString(value, 'patientId'),
    patientName: requireStringOrNull(value, 'patientName'),
    patientBirthDate: requireStringOrNull(value, 'patientBirthDate'),
    accessToken: requireNonEmptyString(value, 'accessToken'),
    fhirBaseUrl: requireNonEmptyString(value, 'fhirBaseUrl'),
  }
}

/**
 * Decodes the configuration page's `webviewclosed` response — the settings
 * JSON, URI-encoded. Throws when the response is not that shape.
 *
 * @param {string} response
 * @returns {import('./settings.js').Settings}
 */
function decodeResponse(response) {
  return decodeSettings(JSON.parse(decodeURIComponent(response)))
}

/**
 * The settings `webviewclosed` last stored under {@link STORAGE_KEY}, or throws
 * when the configuration page has never saved any.
 *
 * @param {string | null} stored - `localStorage.getItem(STORAGE_KEY)`
 * @returns {import('./settings.js').Settings}
 */
function decodeStored(stored) {
  if (stored === null) {
    throw new Error('No settings stored; open the settings page first')
  }
  return decodeSettings(JSON.parse(stored))
}

/**
 * The AppMessage the watch shows the connection from: who the patient is and
 * when the settings arrived (`receivedAtMs`, as `Date.now()` reports it). The
 * token and server stay on the phone. AppMessage has no null, so a missing name
 * or birth date is sent as the empty string, which the watch reads as "none".
 *
 * @param {import('./settings.js').Settings} settings
 * @param {number} receivedAtMs
 * @returns {import('./settings.js').WatchMessage}
 */
function toWatchMessage(settings, receivedAtMs) {
  return {
    PatientName: settings.patientName === null ? '' : settings.patientName,
    PatientBirthDate: settings.patientBirthDate === null ? '' : settings.patientBirthDate,
    AuthTime: Math.floor(receivedAtMs / 1000),
  }
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  decodeResponse: decodeResponse,
  decodeStored: decodeStored,
  toWatchMessage: toWatchMessage,
}

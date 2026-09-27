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
 * Decodes the configuration page's `webviewclosed` response — the settings
 * JSON, URI-encoded — keeping only the fields the settings carry. Throws when
 * the response is not that shape.
 *
 * @param {string} response
 * @returns {import('./settings.js').Settings}
 */
function decodeResponse(response) {
  /** @type {unknown} */
  var value = JSON.parse(decodeURIComponent(response))
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
  toWatchMessage: toWatchMessage,
}

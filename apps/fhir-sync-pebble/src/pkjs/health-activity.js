// Health Activity sync: the watch's activity messages in, a FHIR transaction
// Bundle of Observations out. Kept free of the Pebble globals so
// test/health-activity.test.ts can load it under Node. Written as ES5
// CommonJS, which every PebbleKit JS runtime accepts.

/**
 * The code system for Pebble's HealthService: its SDK docs page, with each
 * `HealthActivity` name as a code.
 */
var HEALTH_SERVICE_SYSTEM =
  'https://developer.repebble.com/docs/c/Foundation/Event_Service/HealthService/'

/** Observation.code for every activity. */
var HEALTH_ACTIVITY_CODING = {
  system: HEALTH_SERVICE_SYSTEM,
  code: 'HealthActivity',
  display: 'Pebble Health Activity',
}

var ACTIVITY_CATEGORY_CODING = {
  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
  code: 'activity',
  display: 'Activity',
}

/**
 * The value coding for each `HealthActivity`, keyed by its value in pebble.h
 * (one bit each). `HealthActivityNone` (0) is never recorded, so it has none.
 *
 * @type {Readonly<Record<number, import('./health-activity.js').Coding>>}
 */
var ACTIVITY_CODINGS = {
  1: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivitySleep', display: 'Sleeping' },
  2: {
    system: HEALTH_SERVICE_SYSTEM,
    code: 'HealthActivityRestfulSleep',
    display: 'Restful Sleeping',
  },
  4: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityWalk', display: 'Walking' },
  8: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityRun', display: 'Running' },
  16: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityOpenWorkout', display: 'Open Workout' },
}

/**
 * @param {object} payload
 * @param {string} key
 * @returns {number}
 */
function requireInteger(payload, key) {
  /** @type {unknown} */
  var field = payload[key]
  if (typeof field !== 'number' || field % 1 !== 0) {
    throw new Error('Message field ' + key + ' must be an integer')
  }
  return field
}

/**
 * Decodes one activity message from the watch — `ActivityType` (a
 * `HealthActivity` value), `ActivityStart` and `ActivityEnd` (Unix seconds).
 * Throws on an unknown activity or an end before the start.
 *
 * @param {object} payload - the AppMessage payload, keyed by message key name
 * @returns {import('./health-activity.js').Activity}
 */
function decodeActivityMessage(payload) {
  var activityType = requireInteger(payload, 'ActivityType')
  var coding = Object.prototype.hasOwnProperty.call(ACTIVITY_CODINGS, activityType)
    ? ACTIVITY_CODINGS[activityType]
    : undefined
  if (coding === undefined) {
    throw new Error('Unknown HealthActivity ' + activityType)
  }
  var startSeconds = requireInteger(payload, 'ActivityStart')
  var endSeconds = requireInteger(payload, 'ActivityEnd')
  if (endSeconds < startSeconds) {
    throw new Error('Activity ends before it starts')
  }
  return { coding: coding, startSeconds: startSeconds, endSeconds: endSeconds }
}

/**
 * Decodes the message ending the watch's activities, whose `ActivityCount` is
 * how many activity messages it sent before it.
 *
 * @param {object} payload - the AppMessage payload, keyed by message key name
 * @returns {number}
 */
function decodeActivityCount(payload) {
  var count = requireInteger(payload, 'ActivityCount')
  if (count < 0) {
    throw new Error('Message field ActivityCount must not be negative')
  }
  return count
}

/**
 * The device display for the watch `Pebble.getActiveWatchInfo()` describes:
 * its model, platform and firmware, like "pebble_time_2_black (emery, firmware
 * 4.9.0)". Throws when the info is not that shape.
 *
 * @param {unknown} watchInfo
 * @returns {string}
 */
function describeWatch(watchInfo) {
  if (typeof watchInfo !== 'object' || watchInfo === null) {
    throw new Error('Watch info must be an object')
  }
  /** @type {unknown} */
  var firmware = watchInfo.firmware
  if (typeof firmware !== 'object' || firmware === null) {
    throw new Error('Watch info firmware must be an object')
  }
  /** @type {unknown} */
  var model = watchInfo.model
  /** @type {unknown} */
  var platform = watchInfo.platform
  if (typeof model !== 'string' || typeof platform !== 'string') {
    throw new Error('Watch info model and platform must be strings')
  }
  var version =
    requireInteger(firmware, 'major') +
    '.' +
    requireInteger(firmware, 'minor') +
    '.' +
    requireInteger(firmware, 'patch')
  /** @type {unknown} */
  var suffix = firmware.suffix
  if (typeof suffix === 'string' && suffix.length > 0) {
    version += '-' + suffix
  }
  return model + ' (' + platform + ', firmware ' + version + ')'
}

/**
 * @param {number} seconds - Unix seconds
 * @returns {string} a FHIR dateTime in UTC
 */
function toDateTime(seconds) {
  return new Date(seconds * 1000).toISOString()
}

/**
 * The Observation recording `activity` for the patient `patientId`, made by the
 * watch `watchDisplay` names.
 *
 * @param {import('./health-activity.js').Activity} activity
 * @param {string} patientId
 * @param {string} watchDisplay - {@link describeWatch}'s text
 * @returns {import('./health-activity.js').ActivityObservation}
 */
function toObservation(activity, patientId, watchDisplay) {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [ACTIVITY_CATEGORY_CODING] }],
    code: { coding: [HEALTH_ACTIVITY_CODING] },
    subject: { reference: 'Patient/' + patientId },
    effectivePeriod: {
      start: toDateTime(activity.startSeconds),
      end: toDateTime(activity.endSeconds),
    },
    valueCodeableConcept: { coding: [activity.coding] },
    device: { display: watchDisplay },
  }
}

/**
 * A transaction Bundle creating every Observation, of any kind: the server
 * stores all of them or none.
 *
 * @template R
 * @param {ReadonlyArray<R>} observations
 * @returns {import('./health-activity.js').TransactionBundle<R>}
 */
function toTransactionBundle(observations) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: observations.map(function (observation) {
      return { resource: observation, request: { method: 'POST', url: 'Observation' } }
    }),
  }
}

module.exports = {
  ACTIVITY_CATEGORY_CODING: ACTIVITY_CATEGORY_CODING,
  HEALTH_SERVICE_SYSTEM: HEALTH_SERVICE_SYSTEM,
  requireInteger: requireInteger,
  toDateTime: toDateTime,
  decodeActivityCount: decodeActivityCount,
  decodeActivityMessage: decodeActivityMessage,
  describeWatch: describeWatch,
  toObservation: toObservation,
  toTransactionBundle: toTransactionBundle,
}

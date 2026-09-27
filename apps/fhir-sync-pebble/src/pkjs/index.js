// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch, and posts the watch's Health activities and minute history to the
// FHIR server. Implements developer.repebble.com's "App Configuration
// (Static)".

var healthActivity = require('./health-activity')
var minuteHistory = require('./minute-history')
var settings = require('./settings')

var CONFIGURATION_URL = 'https://wildflowerhealth.io/fhir-sync-pebble/'

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(CONFIGURATION_URL)
})

Pebble.addEventListener('webviewclosed', function (event) {
  // An empty response means the page closed without saving.
  if (!event.response) {
    return
  }
  var decoded = settings.decodeResponse(event.response)
  localStorage.setItem(settings.STORAGE_KEY, JSON.stringify(decoded))
  Pebble.sendAppMessage(
    settings.toWatchMessage(decoded, Date.now()),
    function () {},
    function (error) {
      // PebbleKit JS logs only through console, which `pebble logs` shows.
      // oxlint-disable-next-line no-console
      console.error('Sending settings to the watch failed: ' + JSON.stringify(error))
    }
  )
})

// The sync. The watch sends one message per activity, then one per hour of
// minute history, then one with ActivityCount and MinuteHourCount; this posts
// them to the FHIR server as one transaction and answers SyncSucceeded. See
// src/c/sync.h for the other side.

/**
 * @returns {{ activities: Array<import('./health-activity.js').Activity>, hours: Array<import('./minute-history.js').MinuteHour> }}
 */
function emptyPendingSync() {
  return { activities: [], hours: [] }
}

// What the sync under way has decoded so far, or null once a message failed to
// decode, which fails the whole sync.
/** @type {ReturnType<typeof emptyPendingSync> | null} */
var pendingSync = emptyPendingSync()

/** @param {boolean} succeeded */
function replyToWatch(succeeded) {
  Pebble.sendAppMessage(
    { SyncSucceeded: succeeded ? 1 : 0 },
    function () {},
    function (error) {
      // oxlint-disable-next-line no-console
      console.error('Sending the sync result to the watch failed: ' + JSON.stringify(error))
    }
  )
}

/**
 * Posts the sync's Observations, then calls done with whether the server
 * stored them. Throws when the settings or watch info can't be read.
 *
 * @param {ReturnType<typeof emptyPendingSync>} sync
 * @param {(succeeded: boolean) => void} done
 */
function postSync(sync, done) {
  var stored = settings.decodeStored(localStorage.getItem(settings.STORAGE_KEY))
  if (sync.activities.length === 0 && sync.hours.length === 0) {
    done(true)
    return
  }
  var watchDisplay = healthActivity.describeWatch(Pebble.getActiveWatchInfo())
  /** @type {Array<import('./health-activity.js').ActivityObservation | import('./minute-history.js').MinuteObservation>} */
  var observations = sync.activities.map(function (activity) {
    return healthActivity.toObservation(activity, stored.patientId, watchDisplay)
  })
  sync.hours.forEach(function (hour) {
    Array.prototype.push.apply(
      observations,
      minuteHistory.toObservations(hour, stored.patientId, watchDisplay)
    )
  })
  if (observations.length === 0) {
    done(true)
    return
  }
  var request = new XMLHttpRequest()
  request.open('POST', stored.fhirBaseUrl)
  request.setRequestHeader('Content-Type', 'application/fhir+json')
  request.setRequestHeader('Accept', 'application/fhir+json')
  request.setRequestHeader('Authorization', 'Bearer ' + stored.accessToken)
  // Pebble documents XMLHttpRequest through its on-handlers, which every
  // PebbleKit JS runtime supports.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  request.onload = function () {
    var succeeded = request.status >= 200 && request.status < 300
    if (!succeeded) {
      // oxlint-disable-next-line no-console
      console.error('FHIR transaction failed: ' + request.status + ' ' + request.responseText)
    }
    done(succeeded)
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  request.onerror = function () {
    // oxlint-disable-next-line no-console
    console.error('FHIR transaction could not reach ' + stored.fhirBaseUrl)
    done(false)
  }
  request.send(JSON.stringify(healthActivity.toTransactionBundle(observations)))
}

/**
 * Adds one activity or hour message to the sync under way, failing the sync
 * when it doesn't decode.
 *
 * @param {(pending: ReturnType<typeof emptyPendingSync>) => void} add
 */
function addToPendingSync(add) {
  if (pendingSync === null) {
    return
  }
  try {
    add(pendingSync)
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('Dropping the sync: ' + error)
    pendingSync = null
  }
}

Pebble.addEventListener('appmessage', function (event) {
  /** @type {unknown} */
  var payload = event.payload
  if (typeof payload !== 'object' || payload === null) {
    return
  }
  if ('ActivityType' in payload) {
    addToPendingSync(function (pending) {
      pending.activities.push(healthActivity.decodeActivityMessage(payload))
    })
    return
  }
  if ('MinuteHourStart' in payload) {
    addToPendingSync(function (pending) {
      pending.hours.push(minuteHistory.decodeMinuteHourMessage(payload))
    })
    return
  }
  if (!('ActivityCount' in payload)) {
    return
  }
  var sync = pendingSync
  pendingSync = emptyPendingSync()
  try {
    var activityCount = healthActivity.decodeActivityCount(payload)
    var hourCount = minuteHistory.decodeMinuteHourCount(payload)
    if (
      sync === null ||
      sync.activities.length !== activityCount ||
      sync.hours.length !== hourCount
    ) {
      throw new Error('The watch sent messages that did not all arrive')
    }
    postSync(sync, replyToWatch)
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('Sync failed: ' + error)
    replyToWatch(false)
  }
})

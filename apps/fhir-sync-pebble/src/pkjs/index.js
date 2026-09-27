// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch, and posts the watch's Health activities to the FHIR server.
// Implements developer.repebble.com's "App Configuration (Static)".

var healthActivity = require('./health-activity')
var settings = require('./settings')

var CONFIGURATION_URL = 'https://wildflowerhealthio.github.io/staging/pr-758/fhir-sync-pebble' //'https://wildflowerhealth.io/fhir-sync-pebble/'

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

// Health Activity sync. The watch sends one message per activity, then one
// with ActivityCount; this posts them to the FHIR server as one transaction and
// answers SyncSucceeded. See src/c/sync.c for the other side.

// The activities decoded so far in the sync under way, or null once one failed
// to decode, which fails the whole batch.
/** @type {Array<import('./health-activity.js').Activity> | null} */
var pendingActivities = []

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
 * Posts activities as Observations, then calls done with whether the server
 * stored them. Throws when the settings or watch info can't be read.
 *
 * @param {ReadonlyArray<import('./health-activity.js').Activity>} activities
 * @param {(succeeded: boolean) => void} done
 */
function postActivities(activities, done) {
  var stored = settings.decodeStored(localStorage.getItem(settings.STORAGE_KEY))
  if (activities.length === 0) {
    done(true)
    return
  }
  var watchDisplay = healthActivity.describeWatch(Pebble.getActiveWatchInfo())
  var bundle = healthActivity.toTransactionBundle(
    activities.map(function (activity) {
      return healthActivity.toObservation(activity, stored.patientId, watchDisplay)
    })
  )
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
  request.send(JSON.stringify(bundle))
}

Pebble.addEventListener('appmessage', function (event) {
  /** @type {unknown} */
  var payload = event.payload
  if (typeof payload !== 'object' || payload === null) {
    return
  }
  if ('ActivityType' in payload) {
    if (pendingActivities === null) {
      return
    }
    try {
      pendingActivities.push(healthActivity.decodeActivityMessage(payload))
    } catch (error) {
      // oxlint-disable-next-line no-console
      console.error('Dropping the sync: ' + error)
      pendingActivities = null
    }
    return
  }
  if (!('ActivityCount' in payload)) {
    return
  }
  var activities = pendingActivities
  pendingActivities = []
  try {
    var count = healthActivity.decodeActivityCount(payload)
    if (activities === null || activities.length !== count) {
      throw new Error('The watch sent activities that did not all arrive')
    }
    postActivities(activities, replyToWatch)
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('Health Activity sync failed: ' + error)
    replyToWatch(false)
  }
})

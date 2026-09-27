// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch, and posts the watch's Health activities and minute history to the
// FHIR server. Implements developer.repebble.com's "App Configuration
// (Static)". What the messages mean and the Observations they become are
// fhir-sync-pebble-core's; this is the glue to Pebble's events, AppMessage,
// localStorage and XMLHttpRequest.

import {
  HealthActivity,
  MinuteHistory,
  PhoneSettings,
  WatchDevice,
  WatchSync,
} from 'fhir-sync-pebble-core/pkjs'

const CONFIGURATION_URL = 'https://wildflowerhealth.io/fhir-sync-pebble/'

/** Where the full settings, access token included, are kept on the phone. */
const STORAGE_KEY = 'settings'

/** Logs `message` where `pebble logs` shows it; PebbleKit JS logs only through console. */
const logError = (message: string): void => {
  // oxlint-disable-next-line no-console
  console.error(message)
}

Pebble.addEventListener('showConfiguration', () => {
  Pebble.openURL(CONFIGURATION_URL)
})

Pebble.addEventListener('webviewclosed', (event) => {
  // An empty response means the page closed without saving.
  if (!event.response) {
    return
  }
  const settings = PhoneSettings.decodeResponse(event.response)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  Pebble.sendAppMessage(
    PhoneSettings.toWatchMessage(settings, Date.now()),
    () => {},
    (error) => {
      logError(`Sending settings to the watch failed: ${JSON.stringify(error)}`)
    }
  )
})

// The sync. The watch sends one message per activity, then one per hour of
// minute history, then one with ActivityCount and MinuteHourCount; this posts
// them to the FHIR server as one transaction and answers SyncSucceeded. See
// src/c/sync.h for the other side.

/**
 * What the sync under way has received so far, or null once a message failed
 * to decode, which fails the whole sync.
 */
let pendingSync: WatchSync.Type | null = WatchSync.empty

const replyToWatch = (succeeded: boolean): void => {
  Pebble.sendAppMessage(
    { SyncSucceeded: succeeded ? 1 : 0 },
    () => {},
    (error) => {
      logError(`Sending the sync result to the watch failed: ${JSON.stringify(error)}`)
    }
  )
}

/**
 * Posts the sync's Observations, then calls `done` with whether the server
 * stored them. Throws when the settings or watch info can't be read.
 */
const postSync = (sync: WatchSync.Type, done: (succeeded: boolean) => void): void => {
  const settings = PhoneSettings.decodeStored(localStorage.getItem(STORAGE_KEY))
  if (WatchSync.isEmpty(sync)) {
    done(true)
    return
  }
  const watchDisplay = WatchDevice.describe(Pebble.getActiveWatchInfo())
  const observations = WatchSync.toObservations(sync, settings.patientId, watchDisplay)
  if (observations.length === 0) {
    done(true)
    return
  }
  const request = new XMLHttpRequest()
  request.open('POST', settings.fhirBaseUrl)
  request.setRequestHeader('Content-Type', 'application/fhir+json')
  request.setRequestHeader('Accept', 'application/fhir+json')
  request.setRequestHeader('Authorization', `Bearer ${settings.accessToken}`)
  // Pebble documents XMLHttpRequest through its on-handlers, which every
  // PebbleKit JS runtime supports.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  request.onload = () => {
    const succeeded = request.status >= 200 && request.status < 300
    if (!succeeded) {
      logError(`FHIR transaction failed: ${request.status} ${request.responseText}`)
    }
    done(succeeded)
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  request.onerror = () => {
    logError(`FHIR transaction could not reach ${settings.fhirBaseUrl}`)
    done(false)
  }
  request.send(JSON.stringify(WatchSync.toTransactionBundle(observations)))
}

/**
 * Adds one activity or hour message to the sync under way, failing the sync
 * when it doesn't decode.
 */
const addToPendingSync = (add: (pending: WatchSync.Type) => WatchSync.Type): void => {
  if (pendingSync === null) {
    return
  }
  try {
    pendingSync = add(pendingSync)
  } catch (error) {
    logError(`Dropping the sync: ${String(error)}`)
    pendingSync = null
  }
}

/** Posts the sync `endPayload` ends, answering the watch whether the server stored it. */
const finishPendingSync = (endPayload: AppMessagePayload): void => {
  const sync = pendingSync
  pendingSync = WatchSync.empty
  try {
    postSync(WatchSync.requireComplete(sync, endPayload), replyToWatch)
  } catch (error) {
    logError(`Sync failed: ${String(error)}`)
    replyToWatch(false)
  }
}

Pebble.addEventListener('appmessage', (event) => {
  const { payload } = event
  switch (WatchSync.messageKind(payload)) {
    case 'Activity':
      addToPendingSync((pending) =>
        WatchSync.withActivity(pending, HealthActivity.decodeMessage(payload))
      )
      return
    case 'MinuteHour':
      addToPendingSync((pending) =>
        WatchSync.withHour(pending, MinuteHistory.decodeHourMessage(payload))
      )
      return
    case 'End':
      finishPendingSync(payload)
      return
    case null:
      return
  }
})

// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch, and writes the watch's Health activities and minute history to the
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

// The sync. The watch sends SyncStart, then one message per activity, then
// one per hour of minute history, then one with ActivityCount and
// MinuteHourCount; this PUTs them to the FHIR server as one transaction and
// answers SyncSucceeded with the sync's id. See src/c/sync.h for the other side.

/**
 * How long the FHIR transaction may take before the sync fails. The watch
 * waits longer for the answer (SYNC_RESULT_TIMEOUT_MS in src/c/sync.c), so
 * this fires first and the watch still hears that the sync failed.
 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * The sync under way: what the watch has sent since its SyncStart. Null before
 * the first SyncStart and once the sync ended, so a message outside a started
 * sync is dropped rather than added to the next one.
 */
let pendingSync: WatchSync.Type | null = null

const replyToWatch = (syncId: number, succeeded: boolean): void => {
  Pebble.sendAppMessage(
    WatchSync.toResultMessage(syncId, succeeded),
    () => {},
    (error) => {
      logError(`Sending the sync result to the watch failed: ${JSON.stringify(error)}`)
    }
  )
}

/**
 * Posts the sync's Observations, then calls `done` once with whether the
 * server stored them: on the server's answer, on a network error, or after
 * {@link REQUEST_TIMEOUT_MS} without either. Throws when the settings, watch
 * info or watch token can't be read.
 */
const postSync = (sync: WatchSync.Type, done: (succeeded: boolean) => void): void => {
  const settings = PhoneSettings.decodeStored(localStorage.getItem(STORAGE_KEY))
  if (WatchSync.isEmpty(sync)) {
    done(true)
    return
  }
  const device = WatchDevice.toReference(Pebble.getActiveWatchInfo(), Pebble.getWatchToken())
  const observations = WatchSync.toObservations(sync, settings.patientId, device)
  if (observations.length === 0) {
    done(true)
    return
  }
  const request = new XMLHttpRequest()
  let finished = false
  let timeout: number | null = null
  const finish = (succeeded: boolean): void => {
    if (finished) {
      return
    }
    finished = true
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    done(succeeded)
  }
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
    finish(succeeded)
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  request.onerror = () => {
    logError(`FHIR transaction could not reach ${settings.fhirBaseUrl}`)
    finish(false)
  }
  // A timer rather than XMLHttpRequest's own timeout, which not every
  // PebbleKit JS runtime implements.
  timeout = setTimeout(() => {
    logError(`FHIR transaction timed out after ${REQUEST_TIMEOUT_MS / 1000} s`)
    finish(false)
    request.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    request.send(JSON.stringify(WatchSync.toTransactionBundle(observations)))
  } catch (error) {
    logError(`FHIR transaction could not be sent: ${String(error)}`)
    finish(false)
  }
}

/** Starts the sync `startPayload` begins, dropping whatever an earlier one left. */
const startPendingSync = (startPayload: unknown): void => {
  try {
    pendingSync = WatchSync.start(startPayload)
  } catch (error) {
    logError(`Dropping the sync: ${String(error)}`)
    pendingSync = null
  }
}

/**
 * Adds one activity or hour message to the sync under way, marking the sync
 * undecodable when it doesn't decode. Drops it when no sync is under way.
 */
const addToPendingSync = (add: (pending: WatchSync.Type) => WatchSync.Type): void => {
  const sync = pendingSync
  if (sync === null) {
    logError('Dropping a sync message that arrived outside a sync')
    return
  }
  try {
    pendingSync = add(sync)
  } catch (error) {
    logError(`Dropping the sync: ${String(error)}`)
    pendingSync = WatchSync.asUndecodable(sync)
  }
}

/**
 * Posts the sync `endPayload` ends, answering the watch whether the server
 * stored it. With no sync under way there is no id to answer with, so the
 * watch's own timeout ends its sync.
 */
const finishPendingSync = (endPayload: unknown): void => {
  const sync = pendingSync
  pendingSync = null
  if (sync === null) {
    logError('Dropping the end of a sync that never started')
    return
  }
  const reply = (succeeded: boolean): void => {
    replyToWatch(sync.syncId, succeeded)
  }
  try {
    postSync(WatchSync.requireComplete(sync, endPayload), reply)
  } catch (error) {
    logError(`Sync failed: ${String(error)}`)
    reply(false)
  }
}

Pebble.addEventListener('appmessage', (event) => {
  const { payload } = event
  switch (WatchSync.messageKind(payload)) {
    case 'Start':
      startPendingSync(payload)
      return
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

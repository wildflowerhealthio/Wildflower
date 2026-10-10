// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch, and writes the watch's Health activities and minute history to the
// FHIR server. Implements developer.repebble.com's "App Configuration
// (Static)". What the messages mean, what to do with each and the Observations
// they become are fhir-sync-pebble-core's; this is the glue to Pebble's events,
// AppMessage, localStorage, XMLHttpRequest and timers.

import { PhoneSettings, WatchDevice, WatchSync } from 'fhir-sync-pebble-core/pkjs'

const CONFIGURATION_URL = 'https://wildflowerhealth.io/fhir-sync-pebble/'

/**
 * Where the full settings, access token included, are kept on the phone, with
 * when they arrived (`PhoneSettings.toStored`).
 */
const STORAGE_KEY = 'settings'

/**
 * How long the FHIR transaction may take before the sync fails. The watch
 * waits longer for the answer (SYNC_RESULT_TIMEOUT_MS in src/c/sync.c), so
 * this fires first and the watch still hears that the sync failed.
 */
const REQUEST_TIMEOUT_MS = 60_000

/** Logs `message` where `pebble logs` shows it; PebbleKit JS logs only through console. */
const logError = (message: string): void => {
  // oxlint-disable-next-line no-console
  console.error(message)
}

/**
 * Sends the watch the settings last stored, when there are any. A send that
 * fails (the watchapp wasn't running) is only logged: `ready`, when the
 * watchapp next starts, and a sync from a watch holding another connection
 * both send them again.
 */
const sendStoredSettings = (): void => {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === null) {
    return
  }
  const { settings, receivedAtMs } = PhoneSettings.decodeStored(stored)
  Pebble.sendAppMessage(
    PhoneSettings.toWatchMessage(settings, receivedAtMs),
    () => {},
    (error) => {
      logError(`Sending settings to the watch failed: ${JSON.stringify(error)}`)
    }
  )
}

Pebble.addEventListener('ready', () => {
  sendStoredSettings()
})

Pebble.addEventListener('showConfiguration', () => {
  Pebble.openURL(CONFIGURATION_URL)
})

Pebble.addEventListener('webviewclosed', (event) => {
  // An empty response means the page closed without saving.
  if (!event.response) {
    return
  }
  const settings = PhoneSettings.decodeResponse(event.response)
  localStorage.setItem(STORAGE_KEY, PhoneSettings.toStored(settings, Date.now()))
  sendStoredSettings()
})

// The sync. The watch sends SyncStart, then one message per activity, then
// one per hour of minute history, then one with ActivityCount and
// MinuteHourCount; WatchSync.receive folds each into the sync under way, and
// once it is complete this PUTs it to the FHIR server as one transaction and
// answers SyncSucceeded with the sync's id. See src/c/sync.h for the other side.

/** The sync under way, null for none; only WatchSync.receive changes it. */
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
 * POSTs `bundle` to the FHIR base URL, then calls `done` once with whether the
 * server stored it: on the server's answer, on a network error, or after
 * {@link REQUEST_TIMEOUT_MS} without either, whichever comes first.
 */
const postTransaction = (
  settings: PhoneSettings.Settings,
  bundle: WatchSync.TransactionBundle,
  done: (succeeded: boolean) => void
): void => {
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
    request.open('POST', settings.fhirBaseUrl)
    request.setRequestHeader('Content-Type', 'application/fhir+json')
    request.setRequestHeader('Accept', 'application/fhir+json')
    request.setRequestHeader('Authorization', `Bearer ${settings.accessToken}`)
    request.send(JSON.stringify(bundle))
  } catch (error) {
    logError(`FHIR transaction could not be sent: ${String(error)}`)
    finish(false)
  }
}

/**
 * Writes the complete `sync` as `WatchSync.planWrite` plans it, then answers
 * the watch, exactly once. A sync from a watch holding another connection
 * fails, and the watch gets the stored settings again.
 */
const writeSync = (sync: WatchSync.Type): void => {
  const reply = (succeeded: boolean): void => {
    replyToWatch(sync.syncId, succeeded)
  }
  let plan: WatchSync.WritePlan
  let settings: PhoneSettings.Settings
  try {
    settings = PhoneSettings.decodeStored(localStorage.getItem(STORAGE_KEY)).settings
    plan = WatchSync.planWrite(sync, settings, () =>
      WatchDevice.toReference(Pebble.getActiveWatchInfo(), Pebble.getWatchToken())
    )
  } catch (error) {
    logError(`Sync ${sync.syncId} failed: ${String(error)}`)
    reply(false)
    return
  }
  switch (plan._tag) {
    case 'WrongConnection':
      logError(`Sync ${sync.syncId} is for another connection; sending the settings again`)
      reply(false)
      sendStoredSettings()
      return
    case 'Nothing':
      reply(true)
      return
    case 'Transaction':
      postTransaction(settings, plan.bundle, reply)
      return
  }
}

Pebble.addEventListener('appmessage', (event) => {
  const { pending, action } = WatchSync.receive(pendingSync, event.payload)
  pendingSync = pending
  switch (action._tag) {
    case 'Continue':
      return
    case 'Drop':
      logError(action.reason)
      return
    case 'Fail':
      logError(`Sync ${action.syncId} failed: ${action.reason}`)
      replyToWatch(action.syncId, false)
      return
    case 'Write':
      writeSync(action.sync)
      return
  }
})

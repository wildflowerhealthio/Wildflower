// PebbleKit JS: opens the settings page pre-filled with the current weights,
// and passes what it saves on to the watch. Implements
// developer.repebble.com's "App Configuration (Static)". What the page's
// response means and the message the watch receives are watch-lifts-core-js's;
// this is the glue to Pebble's events, AppMessage and localStorage.

import { PhoneSettings } from 'watch-lifts-core-js/pkjs'

const CONFIGURATION_URL = 'https://wildflowerhealth.io/watch-lifts/'

/** Where the weights the page last saved are kept on the phone (`PhoneSettings.toStored`). */
const STORAGE_KEY = 'settings'

/** Logs `message` where `pebble logs` shows it; PebbleKit JS logs only through console. */
const logError = (message: string): void => {
  // oxlint-disable-next-line no-console
  console.error(message)
}

/**
 * Sends the watch `settings`. A send that fails (the watchapp wasn't running)
 * is only logged: `ready`, when the watchapp next starts, sends the stored
 * weights again.
 */
const sendSettings = (settings: PhoneSettings.Settings): void => {
  Pebble.sendAppMessage(
    PhoneSettings.toWatchMessage(settings),
    () => {},
    (error) => {
      logError(`Sending the weights to the watch failed: ${JSON.stringify(error)}`)
    }
  )
}

// The watch keeps the weights it last received, so this only matters when a
// save's send failed; with none stored the watch keeps its own.
Pebble.addEventListener('ready', () => {
  const settings = PhoneSettings.decodeStored(localStorage.getItem(STORAGE_KEY))
  if (settings !== null) {
    sendSettings(settings)
  }
})

Pebble.addEventListener('showConfiguration', () => {
  const settings =
    PhoneSettings.decodeStored(localStorage.getItem(STORAGE_KEY)) ?? PhoneSettings.DEFAULT
  Pebble.openURL(PhoneSettings.configurationUrl(CONFIGURATION_URL, settings))
})

Pebble.addEventListener('webviewclosed', (event) => {
  // An empty response means the page closed without saving.
  if (!event.response) {
    return
  }
  const settings = PhoneSettings.decodeResponse(event.response)
  localStorage.setItem(STORAGE_KEY, PhoneSettings.toStored(settings))
  sendSettings(settings)
})

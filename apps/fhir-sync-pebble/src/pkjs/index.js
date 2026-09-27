// PebbleKit JS: opens the configuration page and passes what it saves on to
// the watch. Implements developer.repebble.com's "App Configuration (Static)".

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

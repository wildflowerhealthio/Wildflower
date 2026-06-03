const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins')

// react-native-background-actions declares this service in its own
// AndroidManifest, but without a `foregroundServiceType`. Android 14+
// (targetSdk 34+, which RN 0.81 uses) rejects a foreground service that
// has no type, so we merge `dataSync` onto the same service node here.
// Android's manifest merger combines this attribute onto the library's
// declaration; the type must also be passed in the JS `start()` options
// (see SERVER_BACKGROUND_OPTIONS in daemons/background-server.ts).
const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask'
const FOREGROUND_SERVICE_TYPE = 'dataSync'

/**
 * Expo config plugin: stamps `android:foregroundServiceType="dataSync"`
 * onto the RNBackgroundActionsTask service in the generated Android
 * manifest. Referenced from app.json `plugins`.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @returns {import('expo/config').ExpoConfig}
 */
const withBackgroundActions = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    if (!Array.isArray(application.service)) {
      application.service = []
    }
    let service = application.service.find((entry) => entry.$?.['android:name'] === SERVICE_NAME)
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME } }
      application.service.push(service)
    }
    service.$['android:foregroundServiceType'] = FOREGROUND_SERVICE_TYPE
    return cfg
  })

module.exports = withBackgroundActions

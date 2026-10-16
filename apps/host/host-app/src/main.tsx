import { createBrowserHistory } from '@tanstack/react-router'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import 'tundra-css'
import '@wildflowerhealthio/react-tundraish/styles.css'
import { makeTauriTransport } from '@wildflowerhealthio/effect-messaging-tauri-js'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'
import type { HostPlatform } from '@wildflowerhealthio/servers-core-js'
import type { BaseGateProps } from '@wildflowerhealthio/servers-react'
import { Effect } from 'effect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Named imports, so only these fields of the host's configuration reach the
// bundle.
import {
  background_service_foreground_type as backgroundServiceForegroundType,
  background_service_label as backgroundServiceLabel,
  authorization_app_base_url as authorizationAppBaseUrl,
  launcher_base_url as launcherBaseUrl,
} from '../tauri-shared-config.json'
import { HostRoot } from './host-root.tsx'

addOsColorSchemeListener()

// How the host's unit runner starts its background session, the
// background-service plugin's one service, from the same
// `tauri-shared-config.json` the host's `build.rs` reads. The base enables the
// plugin's recovery with it, so the plugin starts the background session again
// after the OS ends the app.
const backgroundServiceStartConfig = {
  serviceLabel: backgroundServiceLabel,
  foregroundServiceType: backgroundServiceForegroundType,
} as const

// The kind of device the app runs on, fixed when the Tauri CLI builds it: a
// phone suspends or stops the servers once the user leaves the app, which the
// base says on its run-policy field.
const hostPlatform = ((): HostPlatform.Type => {
  const os = import.meta.env.TAURI_ENV_PLATFORM
  return os === 'ios' || os === 'android' ? os : 'desktop'
})()

// The Recorder's bridge transport, built once for the page's lifetime:
// one listener on the host's bridge channel for `RecorderBridge` alone, so the
// channel's other traffic (the sniffer's data plane) is dropped without a word.
// The base doesn't use it.
const recorderTransport = makeTauriTransport({ bridges: [RecorderBridge] as const })

// How the base hears a tap on one of the app's notifications: the
// notification plugin's `actionPerformed`, which only a phone reports. On a
// desktop the plugin has no listener to register, and this rejects. The base
// listens for the page's lifetime; a failed removal is logged.
const listenToNotificationTaps: BaseGateProps['listenToNotificationTaps'] = (handler) =>
  addPluginListener('notification', 'actionPerformed', handler).then((listener) => () => {
    Effect.runFork(
      Effect.tryPromise(() => listener.unregister()).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning('[servers] the notification tap listener was not removed', error)
        )
      )
    )
  })

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('index.html has no #root element')

// The base's telemetry consent dialog first, then one router, over the
// webview's history, with the Servers | Recorder bar over the base's screens,
// which reach the host only through Tauri commands and events, and the
// Recorder. The launcher and Authorization app the host gives a new server
// are the published ones, `launcher_base_url` and `authorization_app_base_url`
// from the same `tauri-shared-config.json` in every build, which the server
// page offers as Reset to default.
createRoot(rootElement).render(
  <StrictMode>
    <HostRoot
      base={{
        invoke,
        platform: hostPlatform,
        listen,
        listenToNotificationTaps,
        backgroundServiceStartConfig,
        defaultLauncherUrl: launcherBaseUrl,
        defaultAuthorizationUrl: authorizationAppBaseUrl,
        telemetry: {
          dsn: import.meta.env.VITE_SENTRY_DSN_HOST_APP ?? '',
          app: 'host-app',
        },
      }}
      history={createBrowserHistory()}
      recorderTransport={recorderTransport}
      revealFile={revealItemInDir}
    />
  </StrictMode>
)

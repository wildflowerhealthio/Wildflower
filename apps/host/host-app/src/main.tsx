import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import 'tundra-css'
import '@wildflowerhealthio/react-tundraish/styles.css'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import { BaseRoot } from '@wildflowerhealthio/servers-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Named imports, so only these fields of the host's configuration reach the
// bundle.
import {
  background_service_foreground_type as backgroundServiceForegroundType,
  background_service_label as backgroundServiceLabel,
  launcher_base_url as launcherBaseUrl,
} from '../tauri-shared-config.json'

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

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('index.html has no #root element')

// The base: its own telemetry consent dialog first, then its screens, which
// reach the host only through Tauri commands and events. The launcher the host
// gives a new server is the published launcher, `launcher_base_url` from the
// same `tauri-shared-config.json` in every build, which the server page offers
// as Reset to default.
createRoot(rootElement).render(
  <StrictMode>
    <BaseRoot
      invoke={invoke}
      listen={listen}
      backgroundServiceStartConfig={backgroundServiceStartConfig}
      defaultLauncherUrl={launcherBaseUrl}
      telemetry={{
        dsn: import.meta.env.VITE_SENTRY_DSN_HOST_APP ?? '',
        app: 'host-app',
      }}
    />
  </StrictMode>
)

import { invoke } from '@tauri-apps/api/core'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { Effect } from 'effect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addOsColorSchemeListener } from 'react-tundraish'
import { BaseRoot } from 'servers-react'
import { configureRecovery } from 'tauri-plugin-background-service'
// Named imports, so only these two fields of the host's configuration reach
// the bundle.
import {
  background_service_foreground_type as backgroundServiceForegroundType,
  background_service_label as backgroundServiceLabel,
} from '../tauri-shared-config.json'

addOsColorSchemeListener()

// The host's unit runner starts the background-service plugin's one service,
// its background session, from Rust whenever a server should run. This records
// that the service should keep running, so the plugin restarts it after the OS
// ends the app: in an iOS background window, or through Android's tap-to-resume
// notification. The start config is the one the unit runner starts with, read
// from the same `tauri-shared-config.json` the host's `build.rs` reads. The
// servers run either way, so a failure only costs those restarts, and is
// logged.
Effect.runFork(
  Effect.tryPromise(() =>
    configureRecovery({
      enabled: true,
      config: {
        serviceLabel: backgroundServiceLabel,
        foregroundServiceType: backgroundServiceForegroundType,
      },
    })
  ).pipe(
    Effect.catchAll((error) =>
      Effect.logError(
        '[background-service] the servers will not restart after the OS ends the app',
        error
      )
    )
  )
)

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('index.html has no #root element')

// The base: its own telemetry consent dialog first, then its screens, which
// reach the host only through Tauri commands.
createRoot(rootElement).render(
  <StrictMode>
    <BaseRoot
      invoke={invoke}
      telemetry={{
        dsn: import.meta.env.VITE_SENTRY_DSN_WILDFLOWER_TAURI ?? '',
        app: 'wildflower-tauri',
      }}
    />
  </StrictMode>
)

import { Outlet } from '@tanstack/react-router'
import { PendingConsentModalHost } from 'gatekeeper-react'
import type { JSX } from 'react'

import { usePlatformBanner } from './platform-banner-context.ts'
import styles from './root-shell.module.css'

// Every slice's client DI (apps, gatekeeper, collector, fhir-r4) has
// migrated to TanStack Query + the router-context runAuthed/runtimeLayer, so no
// slice client providers nest here anymore. Auth/runtime/transport/sender
// providers wrap the router from above (app-root.tsx's InnerWrap).
//
// The entry's platform banner (see `platform-banner-context.ts`) sits above
// the matched route, on every route — the auth gate's error screens included,
// which is where a stopped server shows first. `PendingConsentModalHost` rides
// alongside the router outlet so the consent popup floats over every route.
// It's inert until the host pushes a `bridge:PendingConsentRequested` event
// with a non-null head (Tauri-only — the standalone web entries' stub
// transport never receives one).
const RootShell = (): JSX.Element => (
  <>
    <div className={styles['root-shell']}>
      {usePlatformBanner()}
      <Outlet />
    </div>
    <PendingConsentModalHost />
  </>
)

export { RootShell }

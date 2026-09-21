import { Outlet } from '@tanstack/react-router'
import { PendingConsentModalHost } from 'gatekeeper-react'
import type { JSX } from 'react'

// Every slice's client DI (tunnel, apps, gatekeeper, collector, fhir-r4) has
// migrated to TanStack Query + the router-context runAuthed/runtimeLayer, so no
// slice client providers nest here anymore. Auth/runtime/transport/sender
// providers wrap the router from above (app-root.tsx's InnerWrap).
//
// `PendingConsentModalHost` rides alongside the router outlet so the
// consent popup floats over every route. It's inert until the host
// pushes a `bridge:PendingConsentRequested` event with a non-null head
// (Tauri-only — the standalone web entries' stub transport never
// receives one).
const RootShell = (): JSX.Element => (
  <>
    <Outlet />
    <PendingConsentModalHost />
  </>
)

export { RootShell }

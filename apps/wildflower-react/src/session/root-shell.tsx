import { Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'

// Every slice's client DI (tunnel, apps, gatekeeper, collector, fhir-r4) has
// migrated to TanStack Query + the router-context runAuthed/runtimeLayer, so no
// slice client providers nest here anymore. Auth/runtime/transport/sender
// providers wrap the router from above (app-root.tsx's InnerWrap).
const RootShell = (): JSX.Element => <Outlet />

export { RootShell }

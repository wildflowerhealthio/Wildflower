import { Outlet } from '@tanstack/react-router'
import { DeviceAuthorizationModalHost } from 'gatekeeper-react'
import { Fragment, type JSX } from 'react'

// Every slice's client DI (tunnel, apps, gatekeeper, collector, fhir-r4) has
// migrated to TanStack Query + the router-context runAuthed/runtimeLayer, so no
// slice client providers nest here anymore. Auth/runtime/transport/sender
// providers wrap the router from above (app-root.tsx's InnerWrap).
//
// `DeviceAuthorizationModalHost` rides alongside the `<Outlet />` so the
// device-consent popup floats over whatever route is matched. It reads the
// active head from `<ActiveDeviceRequestProvider>` (mounted above the router in
// app-root.tsx) and stays inert until the host pushes a request.
const RootShell = (): JSX.Element => (
  <Fragment>
    <Outlet />
    <DeviceAuthorizationModalHost />
  </Fragment>
)

export { RootShell }

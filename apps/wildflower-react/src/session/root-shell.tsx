import { Outlet } from '@tanstack/react-router'
import { CollectorClientProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { GatekeeperClientProvider } from 'gatekeeper-react'
import type { JSX } from 'react'

// Slice client-provider nesting. Layers are independent (token is read
// per request from `BearerToken`), so order just mirrors slice load.
//
// Tunnel and apps have no provider here — both were migrated to TanStack
// Query + router-context `runAuthed`. Other slices follow as they migrate.
//
// Auth/runtime/transport/sender providers wrap the router from above
// (`app-root.tsx`'s `InnerWrap`) so the transport — built from
// `useNavigate()`/`useRouter()` — survives child navigations.
const RootShell = (): JSX.Element => (
  <GatekeeperClientProvider>
    <CollectorClientProvider>
      <FhirR4ResourcesClientProvider>
        <Outlet />
      </FhirR4ResourcesClientProvider>
    </CollectorClientProvider>
  </GatekeeperClientProvider>
)

export { RootShell }

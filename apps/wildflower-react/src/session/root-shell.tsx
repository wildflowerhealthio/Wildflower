import { Outlet } from '@tanstack/react-router'
import { CollectorClientProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import type { JSX } from 'react'

// Slice client-provider nesting. Layers are independent (token is read
// per request from `BearerToken`), so order just mirrors slice load.
//
// Tunnel, apps, and gatekeeper have no provider here — all were migrated
// to TanStack Query + router-context `runAuthed`/`runtimeLayer`. Other
// slices follow as they migrate.
//
// Auth/runtime/transport/sender providers wrap the router from above
// (`app-root.tsx`'s `InnerWrap`) so the transport — built from
// `useNavigate()`/`useRouter()` — survives child navigations.
const RootShell = (): JSX.Element => (
  <CollectorClientProvider>
    <FhirR4ResourcesClientProvider>
      <Outlet />
    </FhirR4ResourcesClientProvider>
  </CollectorClientProvider>
)

export { RootShell }

import { Outlet } from '@tanstack/react-router'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import type { JSX } from 'react'

// Slice client-provider nesting. Layers are independent (token is read
// per request from `BearerToken`), so order just mirrors slice load.
//
// Tunnel, apps, gatekeeper, and collector have no provider here — all were
// migrated to TanStack Query + router-context `runAuthed`/`runtimeLayer`.
// Only `fhir-r4-react` remains (its client DI hasn't migrated yet).
//
// Auth/runtime/transport/sender providers wrap the router from above
// (`app-root.tsx`'s `InnerWrap`) so the transport — built from
// `useNavigate()`/`useRouter()` — survives child navigations.
const RootShell = (): JSX.Element => (
  <FhirR4ResourcesClientProvider>
    <Outlet />
  </FhirR4ResourcesClientProvider>
)

export { RootShell }

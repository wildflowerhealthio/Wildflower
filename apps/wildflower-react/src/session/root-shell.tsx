import { Outlet } from '@tanstack/react-router'
import { AppsClientProvider } from 'apps-react'
import { CollectorClientProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { GatekeeperClientProvider } from 'gatekeeper-react'
import type { JSX } from 'react'

// Slice client-provider nesting. Each provider puts one slice's client
// layer in context; the admin layers read the live bearer token from the
// `BearerToken` service per request, so token rotation surfaces without
// remounting any provider. Nesting order is otherwise free — the layers
// are independent — so it just mirrors the slice load order:
//   gatekeeper → collector → fhir-r4 → apps.
//  - `<AppsClientProvider>` provides BOTH the public and admin apps
//    client layers.
//
// The tunnel slice NO LONGER has a client provider here: it was migrated
// fully onto TanStack Query + the router context's `runAuthed` runner
// (Issue #101 Phase 1), so `<TunnelClientProvider>` and the tunnel
// `use*EffectAction` DI are gone. Tunnel reads/writes resolve `runAuthed`
// from the router context instead of a React provider. The remaining four
// providers stay until their own slice is migrated.
//
// The auth/runtime/transport/sender providers (AuthTokenProvider, the two
// RuntimeProviders, TransportProvider, the two SenderForwarders) do NOT
// live here — they wrap the router from above via `app-root.tsx`'s
// `InnerWrap`, so the transport (built from `useNavigate()`/`useRouter()`)
// survives child navigations. See `app-root.tsx` for that stack.
/**
 * Root route component rendered inside TanStack `<RouterProvider>`.
 * Hosts the slice client providers and renders `<Outlet />` so the
 * matched child route mounts under them.
 */
const RootShell = (): JSX.Element => (
  <GatekeeperClientProvider>
    <CollectorClientProvider>
      <FhirR4ResourcesClientProvider>
        <AppsClientProvider>
          <Outlet />
        </AppsClientProvider>
      </FhirR4ResourcesClientProvider>
    </CollectorClientProvider>
  </GatekeeperClientProvider>
)

export { RootShell }

import { Outlet } from '@tanstack/react-router'
import { AppsClientProvider } from 'apps-react'
import { CollectorClientProvider } from 'collector-react'
import { FhirR4ResourcesClientProvider } from 'fhir-r4-react'
import { GatekeeperClientProvider } from 'gatekeeper-react'
import type { JSX } from 'react'
import { TunnelClientProvider } from 'tunnel-react'

// Slice client-provider nesting. Each provider puts one slice's client
// layer in context; the admin layers read the live bearer token from the
// `BearerToken` service per request, so token rotation surfaces without
// remounting any provider. Nesting order is otherwise free — the layers
// are independent — so it just mirrors the slice load order:
//   gatekeeper → collector → fhir-r4 → apps → tunnel.
// Two providers earn a note:
//  - `<AppsClientProvider>` provides BOTH the public and admin apps
//    client layers.
//  - `<TunnelClientProvider>` provides the tunnel slice's admin client
//    layer and has no public counterpart (owner-only API); it takes no
//    props, reading the live token from `BearerToken` like the others.
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
          <TunnelClientProvider>
            <Outlet />
          </TunnelClientProvider>
        </AppsClientProvider>
      </FhirR4ResourcesClientProvider>
    </CollectorClientProvider>
  </GatekeeperClientProvider>
)

export { RootShell }

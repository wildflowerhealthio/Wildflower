import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen.ts'

// Slice-local router registration. The app composes these routes into its
// own router; this slice never mounts one at runtime. But `Route.useParams()`
// / `Route.useSearch()` in the route files resolve their param/search types
// against `RegisteredRouter`, so without a registration here those calls
// degrade to `any`. Registering a router built from the slice's own
// generated tree makes them resolve against the slice-local routes — giving
// the route files type-safe params while compiling standalone.
const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

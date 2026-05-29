import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { Layer } from 'effect'

import { routeTree } from './routeTree.gen.ts'

// Slice-local router registration. The app composes these routes into its
// own router; this slice never mounts one at runtime. But `Route.useParams()`
// / `Route.useSearch()` in the route files resolve their param/search types
// against `RegisteredRouter`, so without a registration here those calls
// degrade to `any`. Registering a router built from the slice's own
// generated tree makes them resolve against the slice-local routes — giving
// the route files type-safe params while compiling standalone. This
// `Register` augmentation must NOT be imported into the app build: `Register`
// is a global singleton, so two slice-local `router` declarations sharing one
// TS program would clash.
//
// The `__root` is `createRootRouteWithContext<RouterContext>()`, so
// `createRouter` requires a `context`. This router is never run — it exists
// only to anchor the `Register` augmentation for param typing — so the
// context fields are inert stubs (`runtimeLayer` would `die` if forced).
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: () => Promise.reject(new Error('slice-local router is never run')),
    runtimeLayer: Layer.die('slice-local router is never run'),
  },
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

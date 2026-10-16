import { createRouter } from '@tanstack/react-router'

import { make } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

// Package-local router registration. The app composes these routes into its
// own router; this package never mounts one at runtime. But `<Link to>` and
// `Route.useParams()` in the route files and screens resolve their types
// against `RegisteredRouter`, so without a registration here those calls
// degrade to `any`. Registering a router built from the package's own
// generated tree makes them resolve against the base's routes while compiling
// standalone. This `Register` augmentation must NOT be imported into the app
// build: `Register` is a global singleton, and the app registers its own
// router. (It is not re-exported from `index.ts`.)
//
// This router is never run — it exists only to anchor the `Register`
// augmentation — so its context's host calls are inert stubs.
const router = createRouter({
  routeTree,
  context: make({
    invoke: () => Promise.reject(new Error('package-local router is never run')),
    platform: 'desktop',
    listen: () => Promise.reject(new Error('package-local router is never run')),
    defaultLauncherUrl: '',
    defaultAuthorizationUrl: '',
  }),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The `_auth` layout index (`/`). The app's owner-facing surfaces are the
 * three tabs (`/home`, `/collector`, `/settings`), so the bare root has
 * no content of its own — it redirects to the apps landing, the same
 * post-sign-in default the device-login flow targets
 * (`POST_AUTH_DEFAULT_PATH`).
 *
 * This replaces a former second "Home" landing that just re-listed the
 * tab destinations (including a confusing "Home → /home" link) — dead
 * scaffolding that duplicated the tab bar.
 */
const Route = createFileRoute('/_auth/')({
  beforeLoad: () => {
    throw redirect({ to: '/home' })
  },
})

export { Route }

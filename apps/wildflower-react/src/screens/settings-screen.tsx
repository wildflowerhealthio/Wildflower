import type { JSX } from 'react'

/**
 * Placeholder for the embedded SPA's `/settings` route. The host shell
 * activates the Settings tab by sending
 * `NavigationBridge.HostRequestedWebNavigation` with `path: '/settings'`;
 * this screen confirms the route resolves. Real settings (account,
 * theme, tunnel control) land here as the host gains capabilities.
 */
const SettingsScreen = (): JSX.Element => (
  <section>
    <h1>Settings</h1>
    <p>Coming soon.</p>
  </section>
)

export { SettingsScreen }

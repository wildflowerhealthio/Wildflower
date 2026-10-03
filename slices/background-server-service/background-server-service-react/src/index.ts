/**
 * The background server service's browser surface: the `ServerStatusBanner`
 * the Tauri entry mounts in the app shell and the Settings row it adds, the
 * status store and the boot-stable bridge handler that fills it, the
 * `RestartServer` sender, and —
 * mounted through the app's `routes.config.ts`, not through this entry — the
 * `/settings/server` page under `src/routes`.
 *
 * @packageDocumentation
 */
export {
  BackgroundServerServiceSenderProvider,
  type BackgroundServerServiceSenderProviderProps,
} from './background-server-service-sender-provider.tsx'
export type {
  BackgroundServerServiceOutboundMessage,
  BackgroundServerServiceSender,
} from './background-server-service-sender-context.ts'
export {
  ServerServiceStatusProvider,
  type ServerServiceStatusProviderProps,
} from './server-service-status-provider.tsx'
export {
  makeServerServiceStatusStore,
  useServerServiceStatus,
  type ServerServiceStatusStore,
} from './server-service-status-store.ts'
export { ServerStatusBanner } from './server-status-banner.tsx'
export { backgroundServerServiceSettingsItemsFragment } from './settings-fragments.ts'
export { makeBackgroundServerServiceWebHandlers } from './web-bridge.ts'

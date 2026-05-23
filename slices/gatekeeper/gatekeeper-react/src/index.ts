export {
  gatekeeperOpenRoutesFragment,
  gatekeeperAuthenticatedRoutesFragment,
  gatekeeperSettingsRoutesFragment,
} from './routes.tsx'
export { gatekeeperSettingsItemsFragment } from './settings-fragments.ts'

export {
  GatekeeperClientLayerContext,
  GatekeeperClientProvider,
  useGatekeeperClientLayer,
  useGatekeeperEffect,
  useGatekeeperEffectAction,
  useGatekeeperStream,
  type GatekeeperEffectAction,
} from './gatekeeper-client.tsx'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export { TOKEN_STORAGE_KEY, authTokenRef, writeToken } from './client/token-storage.ts'
export { waitForHostTokenRef } from './client/wait-for-host-token-ref.ts'

export { useGatekeeperHostMessaging } from './use-gatekeeper-host-messaging.ts'
export type {
  GatekeeperHostMessaging,
  GatekeeperHostToWebMessage,
} from './use-gatekeeper-host-messaging.ts'

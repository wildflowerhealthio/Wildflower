export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment } from './routes.tsx'

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

export { useGatekeeperHostMessaging } from './use-gatekeeper-host-messaging.ts'
export type {
  GatekeeperHostMessaging,
  GatekeeperHostToWebMessage,
} from './use-gatekeeper-host-messaging.ts'

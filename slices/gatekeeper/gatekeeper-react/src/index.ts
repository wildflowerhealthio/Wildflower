export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment } from './routes.tsx'

export {
  GatekeeperClientLayerContext,
  GatekeeperClientProvider,
  useGatekeeperClientLayer,
  useGatekeeperEffect,
  useGatekeeperEffectRunner,
  useGatekeeperStream,
  type GatekeeperEffectRunner,
} from './gatekeeper-client.tsx'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export { TOKEN_STORAGE_KEY, authTokenRef, writeToken } from './client/token-storage.ts'

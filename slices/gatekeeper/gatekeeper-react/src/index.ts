export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment } from './routes.tsx'

export {
  GatekeeperClientProvider,
  type GatekeeperClientProviderProps,
} from './gatekeeper-client-context.tsx'
export { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

export {
  buildGatekeeperClientLayer,
  makeBearerTokenClientTransformer,
  type GatekeeperClientRequirements,
} from './client/gatekeeper-client.ts'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export { TOKEN_STORAGE_KEY, readToken, subscribeToken, writeToken } from './client/token-storage.ts'
export { useToken } from './client/use-token.ts'

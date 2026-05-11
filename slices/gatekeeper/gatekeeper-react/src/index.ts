export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment } from './routes.tsx'

export {
  GatekeeperClientProvider,
  type GatekeeperClientProviderProps,
} from './gatekeeper-client-context.tsx'
export { useGatekeeperClient } from './use-gatekeeper-client.ts'

export {
  buildGatekeeperClientLayer,
  makeGatekeeperClient,
  setBearerToken,
  type GatekeeperClient,
  type GatekeeperClientEnv,
  type GatekeeperClientRuntime,
} from './client/gatekeeper-client.ts'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export { TOKEN_STORAGE_KEY, readToken, subscribeToken, writeToken } from './client/token-storage.ts'

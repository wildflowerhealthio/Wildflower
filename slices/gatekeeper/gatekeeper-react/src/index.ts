export { gatekeeperPublicRoutesFragment, gatekeeperAuthorizedRoutesFragment } from './routes.tsx'

export {
  GatekeeperClientProvider,
  type GatekeeperClientProviderProps,
} from './gatekeeper-client-context.tsx'
export { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'
export { useGatekeeperEffect } from './use-gatekeeper-effect.ts'
export { useGatekeeperStream } from './use-gatekeeper-stream.ts'
export {
  useGatekeeperEffectRunner,
  type GatekeeperEffectRunner,
} from './use-gatekeeper-effect-runner.ts'

export {
  buildGatekeeperClientLayer,
  // oxlint-disable-next-line typescript-eslint/no-deprecated -- transitional re-export for collector-react's PR-3 layer (which still takes a static token)
  makeBearerTokenClientTransformer,
  type GatekeeperClientRequirements,
} from './client/gatekeeper-client.ts'

export { NeedsAuthMessage } from './components/NeedsAuthMessage.tsx'

export { TOKEN_STORAGE_KEY, authTokenRef, readToken, writeToken } from './client/token-storage.ts'

// `useToken` is a gatekeeper-flavoured re-export of react-kitchen-sink's
// generic `useAuthToken`. Kept for ergonomic call sites that read "the
// gatekeeper token" semantically; new code can pull `useAuthToken`
// directly from rks.
export { useAuthToken as useToken } from 'react-kitchen-sink'

/**
 * The tunnel TanStack-Query surface, split by the resource each module deals
 * with:
 *
 *   - {@link file://./tunnel-state.ts}  — tunnel state (read + optimistic replace)
 *
 * Shared scaffolding lives in {@link file://./keys.ts} (the query-key roots
 * mutations invalidate) and {@link file://./use-run-authed.ts} (the authed-runner
 * hook each `queryFn` reads from router context).
 *
 * Re-exported flat so call sites import from `./queries` without caring
 * which resource module a hook lives in.
 */

export { TUNNEL_STATE_QUERY_KEY } from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export {
  applyTunnelOptimistic,
  buildReplacePayload,
  isTunnelState,
  mightTunnelBeOpen,
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  useTunnelStateQuery,
} from './tunnel-state.ts'
export type {
  RelayInput,
  TunnelReplaceInput,
  TunnelReplaceResult,
  TunnelState,
} from './tunnel-state.ts'

export type { RunAuthed } from '../router-context.ts'

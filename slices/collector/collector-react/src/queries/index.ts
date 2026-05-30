/**
 * The collector TanStack-Query surface.
 *
 *   - {@link ./remotes.ts} — collector remotes (accounts): list + detail
 *     reads, and create / update / delete writes.
 *
 * Shared scaffolding lives in {@link ./keys.ts} (the query-key roots
 * mutations invalidate) and {@link ./use-run-authed.ts} (the authed-runner
 * hook each `queryFn` reads from router context).
 *
 * Re-exported flat so call sites import from `./queries` without caring
 * which resource module a hook lives in.
 */

export { REMOTES_QUERY_KEY, remoteQueryKey } from './keys.ts'
export { useRunAuthed } from './use-run-authed.ts'

export {
  remoteQueryOptions,
  remotesQueryOptions,
  useCreateRemoteMutation,
  useDeleteRemoteMutation,
  useRemoteQuery,
  useRemotesQuery,
  useUpdateRemoteMutation,
} from './remotes.ts'
export type { CreateRemotePayload, Remote, UpdateRemotePayload } from './remotes.ts'

export type { RunAuthed } from '../router-context.ts'

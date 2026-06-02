export {
  buildCollectorClientLayer,
  type CollectorClientRequirements,
} from './client/collector-client.ts'

export * as CollectorRouterContext from './router-context.ts'

export {
  REMOTES_QUERY_KEY,
  remoteQueryOptions,
  remotesQueryOptions,
  useCreateRemoteMutation,
  useDeleteRemoteMutation,
  useRemoteQuery,
  useRemotesQuery,
  useRunAuthed,
  useUpdateRemoteMutation,
  type CreateRemotePayload,
  type Remote,
  type RunAuthed,
  type UpdateRemotePayload,
} from './queries/index.ts'

export {
  CollectorSenderProvider,
  type CollectorSenderProviderProps,
} from './runtime/collector-sender-provider.tsx'
export { useCollectorSender } from './runtime/use-collector-sender.ts'
export type {
  CollectorOutboundMessage,
  CollectorSender,
} from './runtime/collector-sender-context.ts'
export { useRequestSniffableWebView } from './runtime/use-request-sniffable-web-view.ts'

export { useSyncRunner, type RunnerState, type SyncRunnerInput } from './runtime/use-sync-runner.ts'

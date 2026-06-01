export { makeAppsWebHandlers } from './runtime/tunnel-resolver-ref.ts'
export type { TunnelOutcome } from './runtime/tunnel-resolver-ref.ts'
export {
  AppsSenderProvider,
  type AppsSenderProviderProps,
} from './runtime/apps-sender-provider.tsx'
export { useAppsSender } from './runtime/use-apps-sender.ts'
export type { AppsOutboundMessage, AppsSender } from './runtime/apps-sender-context.ts'
export { useRequestTunnel } from './runtime/use-request-tunnel.ts'

export * as AppsRouterContext from './router-context.ts'

export {
  APPS_LIST_QUERY_KEY,
  appsListQueryOptions,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminUpdateMutation,
  useAppsListQuery,
  type AppEntry,
  type CreateCustomAppPayload,
  type UpdateAppPayload,
} from './queries.ts'

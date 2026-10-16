import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import type { RecorderPageProps } from '@wildflowerhealthio/recorder-react'
import {
  BaseGate,
  type BaseGateProps,
  ServersRouterContext,
} from '@wildflowerhealthio/servers-react'
import { useState, type JSX } from 'react'

import { type RecorderTransport, settleRecorderTransport } from './router-context.ts'
import { buildHostRouter } from './router.ts'

/** Props for {@link HostRoot}. */
interface HostRootProps {
  /**
   * What the base needs: its gate's (`invoke`, the background service's start
   * config, how it hears notification taps, its telemetry and where the
   * consent answer is kept) and its
   * routes' (the device's platform, `listen`, the default launcher and
   * Authorization app, and the HTTP client).
   */
  readonly base: Omit<BaseGateProps, 'children'> &
    Omit<ServersRouterContext.RouterContextInputs, 'invoke'>
  /**
   * The window's history, which the router navigates:
   * `createBrowserHistory()` in the app, a memory one in tests.
   */
  readonly history: RouterHistory
  /**
   * The Recorder's bridge transport: `makeTauriTransport` over
   * `RecorderBridge`, which resolves once the host has been told the page is
   * ready.
   */
  readonly recorderTransport: Promise<RecorderTransport>
  /**
   * Show a saved recording in the file manager: `tauri-plugin-opener`'s
   * `revealItemInDir`. The Recorder page reads its folder with the base's
   * `invoke`.
   */
  readonly revealFile: RecorderPageProps['revealFile']
}

/** The host's router and the base's query cache, built once. */
function HostRouter({
  base: { invoke, platform, listen, defaultLauncherUrl, defaultAuthorizationUrl, httpClient },
  history,
  recorderTransport,
  revealFile,
}: Omit<HostRootProps, 'base'> & {
  readonly base: ServersRouterContext.RouterContextInputs
}): JSX.Element {
  const [router] = useState(() =>
    buildHostRouter({
      history,
      context: {
        ...ServersRouterContext.make({
          invoke,
          platform,
          listen,
          defaultLauncherUrl,
          defaultAuthorizationUrl,
          httpClient,
        }),
        recorderConnection: settleRecorderTransport(recorderTransport),
        recorderPage: { invoke, revealFile },
      },
    })
  )
  return (
    <QueryClientProvider client={router.options.context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

/**
 * The host's main window: the base's gate, then one router over the host's
 * routes and the base's.
 *
 * @remarks
 * **The base's gate covers the app.** `BaseGate`'s telemetry consent dialog
 * is the whole page until it is answered: the router, the query cache and the
 * Servers | Recorder bar come after, so nothing calls the host before then.
 *
 * **One router.** `routes.config.ts` composes the host's root (the bar, and
 * the not-found page under it) and `/recorder` with the base's routes, under
 * the `_servers` layout. Its context is the base's, from
 * `ServersRouterContext.make`, whose query cache the `QueryClientProvider`
 * shares, with the Recorder's settled transport and page props beside it.
 */
function HostRoot({ base, history, recorderTransport, revealFile }: HostRootProps): JSX.Element {
  return (
    <BaseGate
      invoke={base.invoke}
      backgroundServiceStartConfig={base.backgroundServiceStartConfig}
      listenToNotificationTaps={base.listenToNotificationTaps}
      telemetry={base.telemetry}
      storage={base.storage}
    >
      <HostRouter
        base={base}
        history={history}
        recorderTransport={recorderTransport}
        revealFile={revealFile}
      />
    </BaseGate>
  )
}

export { HostRoot, type HostRootProps }

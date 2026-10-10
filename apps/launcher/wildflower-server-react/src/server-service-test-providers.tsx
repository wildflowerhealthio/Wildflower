import type { JSX, ReactNode } from 'react'

import type { BackgroundServerServiceSender } from './background-server-service-sender-context.ts'
import { BackgroundServerServiceSenderProvider } from './background-server-service-sender-provider.tsx'
import { ServerServiceStatusProvider } from './server-service-status-provider.tsx'
import type { ServerServiceStatusStore } from './server-service-status-store.ts'

/** The two providers the app mounts above the banner and the page, for tests. */
const ServerServiceTestProviders = ({
  store,
  send,
  children,
}: {
  readonly store: ServerServiceStatusStore
  readonly send: BackgroundServerServiceSender
  readonly children: ReactNode
}): JSX.Element => (
  <ServerServiceStatusProvider store={store}>
    <BackgroundServerServiceSenderProvider send={send}>
      {children}
    </BackgroundServerServiceSenderProvider>
  </ServerServiceStatusProvider>
)

export { ServerServiceTestProviders }

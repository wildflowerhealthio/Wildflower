import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import { RecorderProvider, RecorderSenderProvider } from '@wildflowerhealthio/recorder-react'
import { Match } from 'effect'
import type { JSX, ReactNode } from 'react'

import type { RecorderConnection } from './router-context.ts'

/** Props for {@link RecorderSession}. */
interface RecorderSessionProps {
  /** How the Recorder's transport settled. */
  readonly connection: RecorderConnection
  /** The host's layout, every route included. */
  readonly children: ReactNode
}

/**
 * The Recorder's one recording, around every route: once its transport is
 * connected, the coordinator it registers through, the sender it sends
 * through and the `RecorderProvider` that runs it, so a recording keeps going
 * while another route shows. A failed transport leaves `children` alone, and
 * the Recorder route says why.
 *
 * @remarks
 * `connection` is the root route's loader data, settled before the layout
 * first renders and never changed after, so the providers never come or go
 * under a mounted route.
 */
const RecorderSession = ({ connection, children }: RecorderSessionProps): JSX.Element =>
  Match.value(connection).pipe(
    Match.tag('Connected', ({ transport }) => (
      <HandlerCoordinatorContext.Provider value={transport.coordinator}>
        <RecorderSenderProvider send={transport.sendMessage}>
          <RecorderProvider>{children}</RecorderProvider>
        </RecorderSenderProvider>
      </HandlerCoordinatorContext.Provider>
    )),
    Match.tag('Failed', () => <>{children}</>),
    Match.exhaustive
  )

export { RecorderSession, type RecorderSessionProps }

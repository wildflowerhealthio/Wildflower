import type { JSX, ReactNode } from 'react'

import { RecorderContext } from './recorder-context.ts'
import { useRecorder } from './use-recorder.ts'

/** Props for {@link RecorderProvider}. */
interface RecorderProviderProps {
  readonly children: ReactNode
}

/**
 * Runs the app's one {@link useRecorder} and hands it to every
 * `RecorderPage` below.
 *
 * @remarks
 * The recording lives as long as this provider, not the page: an app that
 * mounts it above its routes keeps a recording going while another route
 * shows, and the page shows it again on its return. Needs a
 * `RecorderSenderProvider` and a `HandlerCoordinatorContext` above it, both
 * over the app's `RecorderBridge` transport.
 */
const RecorderProvider = ({ children }: RecorderProviderProps): JSX.Element => (
  <RecorderContext.Provider value={useRecorder()}>{children}</RecorderContext.Provider>
)

export { RecorderProvider }
export type { RecorderProviderProps }

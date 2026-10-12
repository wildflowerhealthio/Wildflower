import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import { createContext } from 'react'

import type { Recorder } from './use-recorder.ts'

/** The {@link Recorder} a `RecorderProvider` runs, or `null` outside one. */
const RecorderContext = createContext<Recorder | null>(null)
RecorderContext.displayName = 'RecorderContext'

/**
 * The {@link Recorder} the surrounding `RecorderProvider` runs.
 *
 * @throws When no `<RecorderProvider>` is in the tree
 */
const useProvidedRecorder = (): Recorder => useContextOrThrow(RecorderContext)

export { RecorderContext, useProvidedRecorder }

import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import { createContext } from 'react'

import type { RunSmart, SmartRuntime } from './smart-runtime.ts'

/**
 * The {@link SmartRuntime} a completed SMART handshake built, which
 * `smart-app-react`'s `SmartHandshakeGate` provides to the app beneath it.
 */
const SmartRuntimeContext = createContext<SmartRuntime | null>(null)
SmartRuntimeContext.displayName = 'SmartRuntimeContext'

/**
 * Run an Effect over the SMART runtime the page's handshake built: how a
 * component (`smart-app-react`'s `PatientPicker`, an app's page) runs its
 * reads. Throws when no `SmartHandshakeGate` is above it.
 */
const useRunSmart = (): RunSmart => useContextOrThrow(SmartRuntimeContext).runSmart

export { SmartRuntimeContext, useRunSmart }

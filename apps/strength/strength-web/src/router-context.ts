import { useRouteContext } from '@tanstack/react-router'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type { SubscribableStore } from '@wildflowerhealthio/react-kitchen-sink'

import type { SmartClient } from './smart-client.ts'

/**
 * What every route reads from the router, fixed for the visit: the SMART
 * client the handshake completed with, the write runner over it, the
 * picker's state and the StrongLifts template ids. Whose record the page
 * shows is the root route's `?patient=`, so a patient change is a navigation
 * and the router lives as long as the page.
 */
interface RouterContext {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
  /**
   * The patient whose page the reader opened the picker over ("Change
   * patient", by `patientChoiceKeyOf`), or `null` while the picker is closed:
   * the patient line and a tab that needs a lifter both open it.
   */
  readonly patientChangingFrom: SubscribableStore<string | null>
  /**
   * The id the StrongLifts 5×5 template is stored under if a lifter starts
   * it, the same for one lifter for the visit, so a retried start on any tab
   * writes the same id.
   */
  readonly strongLiftsPlanDefinitionIdFor: (patientId: string) => string
}

/** The router's {@link RouterContext}. */
const useStrengthContext = (): RouterContext => useRouteContext({ from: '__root__' })

export { useStrengthContext }
export type { RouterContext }

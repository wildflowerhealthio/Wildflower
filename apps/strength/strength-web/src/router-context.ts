import type { QueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'

import type { SmartClient } from './smart-client.ts'

/**
 * What every route reads from the router, fixed for the visit: the page's
 * query cache, the SMART client the handshake completed with, the write
 * runner over it and the StrongLifts template ids. Whose record the page
 * shows is the path (`/patients/$patientId`, or every patient's
 * `/workouts`), so a patient change is a navigation and the router lives as
 * long as the page.
 */
interface RouterContext {
  /** The page's one query cache, which the handshake ran on too. */
  readonly queryClient: QueryClient
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
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

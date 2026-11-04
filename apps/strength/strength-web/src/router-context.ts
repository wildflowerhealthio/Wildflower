import { useRouteContext } from '@tanstack/react-router'
import type { SmartRouterContext } from '@wildflowerhealthio/fhir-r4-react/smart'

/**
 * What every route reads from the router, fixed for the visit: the SMART
 * router context the handshake's runtime makes (the page's query cache, the
 * connection, and the runner every read and write goes through) and the
 * StrongLifts template ids. Whose record the page
 * shows is the path (`/patients/$patientId`, or every patient's
 * `/workouts`), so a patient change is a navigation and the router lives as
 * long as the page.
 */
interface RouterContext extends SmartRouterContext {
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

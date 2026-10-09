/**
 * The SMART launch a page's URL asks it to start, read the same way by every
 * Wildflower page a launch can open: the fhirclient-based SMART apps (through
 * `fhir-r4-react/smart`, which re-exports it) and the pages that sign in with
 * this package.
 */

import { Option } from 'effect'

import { isAuthorizationResponse } from './authorization-flow.ts'

/**
 * A SMART launch a page was opened to start: the FHIR server it names, and the
 * EHR's opaque launch token when it is an EHR launch.
 */
interface ArrivingSmartLaunch {
  /** The FHIR server base (`iss`) to authorize against. */
  readonly iss: string
  /**
   * The EHR's `launch` token, or `undefined` for a standalone launch against
   * `iss`.
   */
  readonly launch: string | undefined
}

/**
 * The SMART launch `search` asks the page to start, or `None` when it asks for
 * none.
 *
 * @remarks
 * A launch is a non-empty `iss`: with `launch` it is an EHR launch, and without
 * it a standalone launch against `iss` (the link `fhir-r4-react/smart`'s
 * `appLaunchUrl` builds for a server with no launcher). A lone `launch` names
 * no server, so it is no launch. An empty `launch` counts as absent, as it does
 * for fhirclient.
 *
 * A URL carrying any authorization-response parameter (`code`, `state`,
 * `error` or `error_description`; see `isAuthorizationResponse`) is a return
 * from the authorization server, never a launch, whatever else it carries:
 * starting a launch there would abandon the handshake the page is completing,
 * or the failure it reports.
 */
const arrivingSmartLaunchFrom = (search: string): Option.Option<ArrivingSmartLaunch> => {
  if (isAuthorizationResponse(search)) return Option.none()
  const params = new URLSearchParams(search)
  const iss = params.get('iss')
  if (iss === null || iss === '') return Option.none()
  const launch = params.get('launch')
  return Option.some({ iss, launch: launch === null || launch === '' ? undefined : launch })
}

export { arrivingSmartLaunchFrom }
export type { ArrivingSmartLaunch }

/**
 * The curated "It won't be able to…" statements (`spec.md §8`) — each a statement about
 * something *excluded from the request*, shown unless the request already covers it:
 * broad record types, admin surface, background access, and other-patient reach. Never
 * the auto-computed complement of the grant — informational only, rendered by the
 * `ScopePicker`'s `ExclusionRow` group.
 */
import { Scope } from 'scopes-core'
import type { ScopeRequest } from 'scopes-core'

/** One "It won't be able to…" line — a statement about something the app didn't ask for. */
type ExclusionStatement = {
  readonly key: string
  readonly label: string
}

/** The statements the request leaves excluded — each dropped once the request covers it. */
const exclusionStatements = (request: ScopeRequest.ScopeRequest): ExclusionStatement[] => {
  const fhirScopes = [...request.requested.fhirV1, ...request.requested.fhirV2]
  const hasFhirWildcard = fhirScopes.some((scope) => scope.resource.serialize() === '*')
  const hasWildflower = request.requested.wildflower.length > 0
  const hasOfflineAccess = request.requested.known.some((known) => known.name === 'offline_access')
  const hasSystemFhir = fhirScopes.some((scope) => scope.hasContext(Scope.Contexts.Fhir.system))

  const exclusions: ExclusionStatement[] = []
  if (!hasFhirWildcard) {
    exclusions.push({ key: 'other-record-types', label: 'Read or write other health record types' })
  }
  if (!hasWildflower) {
    exclusions.push({ key: 'admin', label: 'Read or write admin settings & connected apps' })
  }
  if (!hasOfflineAccess) {
    exclusions.push({ key: 'offline', label: 'Stay connected in the background' })
  }
  if (!hasSystemFhir) {
    exclusions.push({ key: 'other-patients', label: 'Read or write records for other patients' })
  }
  return exclusions
}

export { type ExclusionStatement, exclusionStatements }

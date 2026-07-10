/**
 * The curated "It won't be able to…" statements (`spec.md §8`) — each a statement about
 * something *excluded from the grant being built*, shown until the draft covers it:
 * broad record types, admin surface, background access, and other-patient reach. Derived
 * from the live draft (not the frozen request envelope) so building a grant up — e.g.
 * toggling the `*` wildcard row in expandable mode — retires the matching statement.
 * Never the auto-computed complement of the grant — informational only, rendered by the
 * `ScopePicker`'s `ExclusionRow` group.
 */
import { Scope } from 'scopes-core'
import type { GrantDraft } from 'scopes-core'

/** One "It won't be able to…" line — a statement about something the draft doesn't grant. */
type ExclusionStatement = {
  readonly key: string
  readonly label: string
}

/** The statements the draft leaves excluded — each dropped once the draft covers it. */
const exclusionStatementsFrom = (draft: GrantDraft.GrantDraft): ExclusionStatement[] => {
  const fhirScopes = [...draft.fhirV1, ...draft.fhirV2]
  const hasFhirWildcard = fhirScopes.some((scope) => scope.resource.serialize() === '*')
  const hasWildflower = draft.wildflower.length > 0
  const hasOfflineAccess = draft.known.some((known) => known.name === 'offline_access')
  const hasSystemFhir = fhirScopes.some((scope) => scope.hasContext(Scope.Contexts.Fhir.system))

  const exclusions: ExclusionStatement[] = []
  if (!hasFhirWildcard) {
    exclusions.push({ key: 'other-record-types', label: 'Read or write other health record types' })
  }
  if (!hasWildflower) {
    exclusions.push({ key: 'admin', label: 'Read or write admin settings & connected apps' })
  }
  if (!hasOfflineAccess) {
    // No offline_access ⇒ no refresh token: access ends when the 15-minute
    // token (`ACCESS_TOKEN_TTL`) expires.
    exclusions.push({ key: 'offline', label: 'Access your data after 15 minutes' })
  }
  if (!hasSystemFhir) {
    exclusions.push({ key: 'other-patients', label: 'Read or write records for other patients' })
  }
  return exclusions
}

export { type ExclusionStatement, exclusionStatementsFrom }

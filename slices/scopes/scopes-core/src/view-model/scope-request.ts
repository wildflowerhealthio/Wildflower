/**
 * Request-mode clamping (`spec.md §2`) and the grid cell view-state that fuses
 * clamp (§2) with wildcard lock (§3). `granted ⊆ requested` is enforced by
 * *disabling* controls outside the scope request, never by silently dropping a
 * selection. A view-model concern (the consent-request framing) with no
 * `scopes-rust` counterpart.
 *
 * Namespace module (`import { ScopeRequest } from 'scopes-core'`).
 */

import type { KnownScope } from '../domain/index.ts'
import { AccessRights, Grant, Scope } from '../domain/index.ts'
import * as Words from '../language/words.ts'
import * as GrantDraft from './grant-draft.ts'
import * as Resolve from './resolve.ts'
import * as ScopeContext from './scope-context.ts'

/** A requested resource scope, with its `required` flag (request mode). */
type RequestedResource = Scope.Resource & { readonly required?: boolean }

/** A requested flag scope, with its `required` flag. */
type RequestedFlag = { readonly scope: KnownScope.KnownScope; readonly required?: boolean }

/**
 * What an app asked for (request mode). The grant is clamped so that
 * `granted ⊆ requested` at all times (`spec.md §2`); `required` scopes are
 * locked on. Absence of a scope request ⇒ open mode (the user builds freely).
 */
type ScopeRequest = {
  readonly resources: readonly RequestedResource[]
  readonly flags: readonly RequestedFlag[]
}

/** The requested resource scope for a (scope context, resource), with its `required` flag. */
const resourceFor = (
  scopeRequest: ScopeRequest,
  scopeContext: ScopeContext.ScopeContext,
  name: string
): RequestedResource | undefined =>
  scopeRequest.resources.find(
    (r) => ScopeContext.contains(scopeContext, r) && Scope.resourceName(r) === name
  )

/**
 * Whether a (scope context, resource) row is edited as v1 *word* access (the
 * Read/Write multiselect) or v2 *letters* (the CRUDS cells). In request mode the
 * form follows what the app asked for; in open mode it follows the grant's
 * stored row, defaulting to v2.
 */
const accessForm = (
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest | null,
  scopeContext: ScopeContext.ScopeContext,
  name: string
): 'word' | 'letters' => {
  if (scopeRequest !== null) {
    const requested = resourceFor(scopeRequest, scopeContext, name)
    return requested === undefined ? 'letters' : AccessRights.form(requested.access)
  }
  const row = GrantDraft.findResource(grant.scopes, scopeContext, name)
  return row === undefined ? 'letters' : AccessRights.form(row.access)
}

/** One of the four visual states a CRUDS cell can be in. */
type CellState = 'on' | 'off' | 'locked' | 'disabled'

/** A resolved grid cell: its state plus the tooltip explaining a lock/disable. */
type Cell = {
  readonly state: CellState
  readonly lockReason: string | null
}

/** Resolve one CRUDS cell for the grid, combining the request clamp (§2) and wildcard lock (§3). */
const buildCell = (
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest | null,
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  action: AccessRights.Action
): Cell => {
  if (scopeRequest !== null) {
    const requested = resourceFor(scopeRequest, scopeContext, name)
    if (requested === undefined || !AccessRights.has(requested.access, action)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
  }
  const eff = Resolve.effectiveCell(grant.scopes, scopeContext, name, action)
  if (eff.locked) return { state: 'locked', lockReason: 'Granted by ✶ All record types' }
  if (scopeRequest !== null) {
    const requested = resourceFor(scopeRequest, scopeContext, name)
    if (requested?.required === true && AccessRights.has(requested.access, action)) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  return { state: eff.granted ? 'on' : 'off', lockReason: null }
}

/** Resolve one v1 word component (Read / Write) for a row's multiselect (§2 clamp). */
const buildWordCell = (
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest | null,
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  component: Words.Component
): Cell => {
  const current = GrantDraft.findResource(grant.scopes, scopeContext, name)?.access ?? null
  if (scopeRequest !== null) {
    const requested = resourceFor(scopeRequest, scopeContext, name)
    if (requested === undefined || !Words.covers(requested.access, component)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
    if (requested.required === true) return { state: 'locked', lockReason: 'Required by the app' }
  }
  return { state: Words.covers(current, component) ? 'on' : 'off', lockReason: null }
}

/** Whether a flag toggle is disabled (request mode + not requested, `spec.md §2/§7`). */
const flagDisabled = (scopeRequest: ScopeRequest | null, flag: KnownScope.KnownScope): boolean => {
  if (scopeRequest === null) return false
  return !scopeRequest.flags.some((f) => f.scope === flag)
}

/** Whether a flag is required (request mode + marked required → locked on). */
const flagRequired = (scopeRequest: ScopeRequest | null, flag: KnownScope.KnownScope): boolean => {
  if (scopeRequest === null) return false
  return scopeRequest.flags.some((f) => f.scope === flag && f.required === true)
}

/**
 * The invariant `granted ⊆ requested` (`spec.md §2`). True in open mode. Checks
 * every granted CRUDS letter and flag against the scope request. For tests/asserts.
 */
const isWithin = (grant: GrantDraft.GrantDraft, scopeRequest: ScopeRequest | null): boolean => {
  if (scopeRequest === null) return true
  const resourcesOk = Grant.resourceScopes(grant.scopes).every((scope) => {
    const requested = resourceFor(scopeRequest, ScopeContext.of(scope), Scope.resourceName(scope))
    if (requested === undefined) return false
    return AccessRights.lettersOf(scope.access).every((a) => AccessRights.has(requested.access, a))
  })
  const flagsOk = Grant.knownScopes(grant.scopes).every((flag) =>
    scopeRequest.flags.some((f) => f.scope === flag)
  )
  return resourcesOk && flagsOk
}

export {
  type RequestedResource,
  type RequestedFlag,
  type ScopeRequest,
  resourceFor,
  accessForm,
  type CellState,
  type Cell,
  buildCell,
  buildWordCell,
  flagDisabled,
  flagRequired,
  isWithin,
}

/**
 * Request-mode clamping (`spec.md §2`) and the grid cell view-state that fuses
 * clamp (§2) with wildcard lock (§3). `granted ⊆ requested` is enforced by
 * *disabling* out-of-envelope controls, never by silently dropping a selection.
 * A view-model concern (the consent-request framing) with no `scopes-rust`
 * counterpart.
 *
 * Namespace module (`import { Envelope } from 'scopes-core'`).
 */

import type { KnownScope } from '../domain/index.ts'
import { AccessRights, Grant, Scope } from '../domain/index.ts'
import * as Words from '../language/words.ts'
import * as Bucket from './bucket.ts'
import * as GrantDraft from './grant-draft.ts'
import * as Resolve from './resolve.ts'

/** A requested resource scope, with its `required` flag (request mode). */
export type RequestedResource = Scope.Resource & { readonly required?: boolean }

/** A requested flag scope, with its `required` flag. */
export type RequestedFlag = { readonly scope: KnownScope.KnownScope; readonly required?: boolean }

/**
 * What an app asked for (request mode). The grant is clamped so that
 * `granted ⊆ requested` at all times (`spec.md §2`); `required` scopes are
 * locked on. Absence of an envelope ⇒ open mode (the user builds freely).
 */
export type Envelope = {
  readonly resources: readonly RequestedResource[]
  readonly flags: readonly RequestedFlag[]
}

/** The requested resource scope for a (bucket, resource), with its `required` flag. */
export const resourceFor = (
  envelope: Envelope,
  bucket: Bucket.Bucket,
  name: string
): RequestedResource | undefined =>
  envelope.resources.find((r) => Bucket.contains(bucket, r) && Scope.resourceName(r) === name)

/**
 * Whether a (bucket, resource) row is edited as v1 *word* access (the Read/Write
 * multiselect) or v2 *letters* (the CRUDS cells). In request mode the form
 * follows what the app asked for; in open mode it follows the grant's stored
 * row, defaulting to v2.
 */
export const accessForm = (
  grant: GrantDraft.GrantDraft,
  envelope: Envelope | null,
  bucket: Bucket.Bucket,
  name: string
): 'word' | 'letters' => {
  if (envelope !== null) {
    const env = resourceFor(envelope, bucket, name)
    return env === undefined ? 'letters' : AccessRights.form(env.access)
  }
  const row = GrantDraft.findResource(grant.scopes, bucket, name)
  return row === undefined ? 'letters' : AccessRights.form(row.access)
}

/** One of the four visual states a CRUDS cell can be in. */
export type CellState = 'on' | 'off' | 'locked' | 'disabled'

/** A resolved grid cell: its state plus the tooltip explaining a lock/disable. */
export type Cell = {
  readonly state: CellState
  readonly lockReason: string | null
}

/** Resolve one CRUDS cell for the grid, combining the request clamp (§2) and wildcard lock (§3). */
export const buildCell = (
  grant: GrantDraft.GrantDraft,
  envelope: Envelope | null,
  bucket: Bucket.Bucket,
  name: string,
  action: AccessRights.Action
): Cell => {
  if (envelope !== null) {
    const env = resourceFor(envelope, bucket, name)
    if (env === undefined || !AccessRights.has(env.access, action)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
  }
  const eff = Resolve.effectiveCell(grant.scopes, bucket, name, action)
  if (eff.locked) return { state: 'locked', lockReason: 'Granted by ✶ All record types' }
  if (envelope !== null) {
    const env = resourceFor(envelope, bucket, name)
    if (env?.required === true && AccessRights.has(env.access, action)) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  return { state: eff.granted ? 'on' : 'off', lockReason: null }
}

/** Resolve one v1 word component (Read / Write) for a row's multiselect (§2 clamp). */
export const buildWordCell = (
  grant: GrantDraft.GrantDraft,
  envelope: Envelope | null,
  bucket: Bucket.Bucket,
  name: string,
  component: Words.Component
): Cell => {
  const current = GrantDraft.findResource(grant.scopes, bucket, name)?.access ?? null
  if (envelope !== null) {
    const env = resourceFor(envelope, bucket, name)
    if (env === undefined || !Words.covers(env.access, component)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
    if (env.required === true) return { state: 'locked', lockReason: 'Required by the app' }
  }
  return { state: Words.covers(current, component) ? 'on' : 'off', lockReason: null }
}

/** Whether a flag toggle is disabled (request mode + not requested, `spec.md §2/§7`). */
export const flagDisabled = (envelope: Envelope | null, flag: KnownScope.KnownScope): boolean => {
  if (envelope === null) return false
  return !envelope.flags.some((f) => f.scope === flag)
}

/** Whether a flag is required (request mode + marked required → locked on). */
export const flagRequired = (envelope: Envelope | null, flag: KnownScope.KnownScope): boolean => {
  if (envelope === null) return false
  return envelope.flags.some((f) => f.scope === flag && f.required === true)
}

/**
 * The invariant `granted ⊆ requested` (`spec.md §2`). True in open mode. Checks
 * every granted CRUDS letter and flag against the envelope. For tests/asserts.
 */
export const isWithin = (grant: GrantDraft.GrantDraft, envelope: Envelope | null): boolean => {
  if (envelope === null) return true
  const resourcesOk = Grant.resourceScopes(grant.scopes).every((scope) => {
    const env = resourceFor(envelope, Bucket.of(scope), Scope.resourceName(scope))
    if (env === undefined) return false
    return AccessRights.lettersOf(scope.access).every((a) => AccessRights.has(env.access, a))
  })
  const flagsOk = Grant.knownScopes(grant.scopes).every((flag) =>
    envelope.flags.some((f) => f.scope === flag)
  )
  return resourcesOk && flagsOk
}

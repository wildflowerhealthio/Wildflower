/**
 * Request-mode clamping (`spec.md §2`) and the grid cell view-state that fuses
 * clamp (§2) with wildcard lock (§3). `granted ⊆ requested` is enforced by
 * *disabling* out-of-envelope controls, never by silently dropping a selection.
 */

import {
  accessForm,
  accessHas,
  accessLetters,
  coversComponent,
  type WordComponent,
} from './access.ts'
import type { Action, Grant, KnownScope, RequestEnvelope, RequestedResource } from './model.ts'
import { effectiveCell } from './resolve.ts'
import {
  fhirBucket,
  findResource,
  flagScopes,
  inBucket,
  resourceScopeName,
  resourceScopes,
  wildflowerBucket,
  type Bucket,
} from './scope.ts'

/** The requested resource scope for a (bucket, resource), with its `required` flag. */
export const envelopeResourceFor = (
  envelope: RequestEnvelope,
  bucket: Bucket,
  name: string
): RequestedResource | undefined =>
  envelope.resources.find((r) => inBucket(r, bucket) && resourceScopeName(r) === name)

/**
 * Whether a (bucket, resource) row is edited as v1 *word* access (the
 * Read/Write multiselect) or v2 *letters* (the CRUDS cells). In request mode the
 * form follows what the app asked for; in open mode it follows the grant's
 * stored row, defaulting to v2.
 */
export const resourceAccessForm = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  bucket: Bucket,
  name: string
): 'word' | 'letters' => {
  if (envelope !== null) {
    const env = envelopeResourceFor(envelope, bucket, name)
    return env === undefined ? 'letters' : accessForm(env.access)
  }
  const row = findResource(grant.scopes, bucket, name)
  return row === undefined ? 'letters' : accessForm(row.access)
}

/** One of the four visual states a CRUDS cell can be in. */
export type CellState = 'on' | 'off' | 'locked' | 'disabled'

/** A resolved grid cell: its state plus the tooltip explaining a lock/disable. */
export interface Cell {
  readonly state: CellState
  readonly lockReason: string | null
}

/** Resolve one CRUDS cell for the grid, combining the request clamp (§2) and wildcard lock (§3). */
export const buildCell = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  bucket: Bucket,
  name: string,
  action: Action
): Cell => {
  if (envelope !== null) {
    const env = envelopeResourceFor(envelope, bucket, name)
    if (env === undefined || !accessHas(env.access, action)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
  }
  const eff = effectiveCell(grant.scopes, bucket, name, action)
  if (eff.locked) return { state: 'locked', lockReason: 'Granted by ✶ All record types' }
  if (envelope !== null) {
    const env = envelopeResourceFor(envelope, bucket, name)
    if (env?.required === true && accessHas(env.access, action)) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  return { state: eff.granted ? 'on' : 'off', lockReason: null }
}

/** Resolve one v1 word component (Read / Write) for a row's multiselect (§2 clamp). */
export const buildWordCell = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  bucket: Bucket,
  name: string,
  component: WordComponent
): Cell => {
  const current = findResource(grant.scopes, bucket, name)?.access ?? null
  if (envelope !== null) {
    const env = envelopeResourceFor(envelope, bucket, name)
    if (env === undefined || !coversComponent(env.access, component)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
    if (env.required === true) return { state: 'locked', lockReason: 'Required by the app' }
  }
  return { state: coversComponent(current, component) ? 'on' : 'off', lockReason: null }
}

/** Whether a flag toggle is disabled (request mode + not requested, `spec.md §2/§7`). */
export const flagDisabled = (envelope: RequestEnvelope | null, flag: KnownScope): boolean => {
  if (envelope === null) return false
  return !envelope.flags.some((f) => f.scope === flag)
}

/** Whether a flag is required (request mode + marked required → locked on). */
export const flagRequired = (envelope: RequestEnvelope | null, flag: KnownScope): boolean => {
  if (envelope === null) return false
  return envelope.flags.some((f) => f.scope === flag && f.required === true)
}

/**
 * The invariant `granted ⊆ requested` (`spec.md §2`). True in open mode. Checks
 * every granted CRUDS letter and flag against the envelope. For tests/asserts.
 */
export const isWithinEnvelope = (grant: Grant, envelope: RequestEnvelope | null): boolean => {
  if (envelope === null) return true
  const resourcesOk = resourceScopes(grant.scopes).every((scope) => {
    const bucket: Bucket = scope.kind === 'fhir' ? fhirBucket(scope.context) : wildflowerBucket
    const env = envelopeResourceFor(envelope, bucket, resourceScopeName(scope))
    if (env === undefined) return false
    return accessLetters(scope.access).every((a) => accessHas(env.access, a))
  })
  const flagsOk = flagScopes(grant.scopes).every((flag) =>
    envelope.flags.some((f) => f.scope === flag)
  )
  return resourcesOk && flagsOk
}

/**
 * Request-mode clamping (`spec.md §2`) and the grid cell view-state that fuses
 * clamp (§2) with wildcard lock (§3). `granted ⊆ requested` is enforced by
 * *disabling* out-of-envelope controls, never by silently dropping a selection.
 */

import { accessHas, accessLetters, coversComponent, type WordComponent } from './access.ts'
import type { Access, Action, Context, FlagScope, Grant, RequestEnvelope } from './model.ts'
import { effectiveCell } from './resolve.ts'

/** The requested permission for a (context, resource), with its `required` flag. */
export const envelopePermissionFor = (
  envelope: RequestEnvelope,
  context: Context,
  resource: string
): RequestEnvelope['permissions'][number] | undefined =>
  envelope.permissions.find((p) => p.context === context && p.resource === resource)

/**
 * Whether a (context, resource) row is edited as v1 *word* access (the
 * None/Read/Write/Both picker) or v2 *letters* (the CRUDS cells). In request
 * mode the form follows what the app asked for — "apps that use v1 expect v1";
 * in open mode it follows the grant's stored row, defaulting to v2.
 */
export const resourceAccessForm = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  context: Context,
  resource: string
): Access['form'] => {
  if (envelope !== null) {
    const env = envelopePermissionFor(envelope, context, resource)
    return env === undefined ? 'letters' : env.access.form
  }
  const row = grant.permissions.find((p) => p.context === context && p.resource === resource)
  return row === undefined ? 'letters' : row.access.form
}

/** One of the four visual states a CRUDS cell can be in. */
export type CellState = 'on' | 'off' | 'locked' | 'disabled'

/** A resolved grid cell: its state plus the tooltip explaining a lock/disable. */
export interface Cell {
  readonly state: CellState
  readonly lockReason: string | null
}

/**
 * Resolve one CRUDS cell for the grid, combining the request clamp (§2) and the
 * wildcard lock (§3):
 *
 * - **disabled** — request mode and the action wasn't requested (out of envelope).
 * - **locked** — covered by the live wildcard, or required by the app.
 * - **on / off** — editable, reflecting whether it's currently granted.
 */
export const buildCell = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  context: Context,
  resource: string,
  action: Action
): Cell => {
  if (envelope !== null) {
    const env = envelopePermissionFor(envelope, context, resource)
    if (env === undefined || !accessHas(env.access, action)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
  }
  const eff = effectiveCell(grant.permissions, context, resource, action)
  if (eff.locked) return { state: 'locked', lockReason: 'Granted by ✶ All record types' }
  if (envelope !== null) {
    const env = envelopePermissionFor(envelope, context, resource)
    if (env?.required === true && accessHas(env.access, action)) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  return { state: eff.granted ? 'on' : 'off', lockReason: null }
}

/**
 * Resolve one v1 word component (Read / Write) for a row's multiselect, applying
 * the same §2 clamp as {@link buildCell}: a component the request doesn't cover
 * is **disabled**, a required scope's components are **locked**, otherwise
 * **on/off** by whether the grant currently selects it. (There is no wildcard
 * lock here — wildcards are v2-only.)
 */
export const buildWordCell = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  context: Context,
  resource: string,
  component: WordComponent
): Cell => {
  const current =
    grant.permissions.find((p) => p.context === context && p.resource === resource)?.access ?? null
  if (envelope !== null) {
    const env = envelopePermissionFor(envelope, context, resource)
    if (env === undefined || !coversComponent(env.access, component)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
    if (env.required === true) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  return { state: coversComponent(current, component) ? 'on' : 'off', lockReason: null }
}

/** Whether a flag toggle is disabled (request mode + not requested, `spec.md §2/§7`). */
export const flagDisabled = (envelope: RequestEnvelope | null, flag: FlagScope): boolean => {
  if (envelope === null) return false
  return !envelope.flags.some((f) => f.scope === flag)
}

/** Whether a flag is required (request mode + marked required → locked on). */
export const flagRequired = (envelope: RequestEnvelope | null, flag: FlagScope): boolean => {
  if (envelope === null) return false
  return envelope.flags.some((f) => f.scope === flag && f.required === true)
}

/**
 * The invariant `granted ⊆ requested` (`spec.md §2`). True in open mode (no
 * envelope). Checks every granted CRUDS letter and flag against the envelope.
 * Intended for tests/asserts.
 */
export const isWithinEnvelope = (grant: Grant, envelope: RequestEnvelope | null): boolean => {
  if (envelope === null) return true
  const permissionsOk = grant.permissions.every((p) => {
    const env = envelopePermissionFor(envelope, p.context, p.resource)
    if (env === undefined) return false
    return accessLetters(p.access).every((a) => accessHas(env.access, a))
  })
  const flagsOk = grant.flags.every((flag) => envelope.flags.some((f) => f.scope === flag))
  return permissionsOk && flagsOk
}

/**
 * The canonical, framework-free scope model for the Wildflower scope picker.
 *
 * This mirrors the structured `Scope` model in `slices/scopes/scopes-rust`
 * (`scope/mod.rs`) so a grant edited in the UI serializes back to the exact
 * strings the Rust `Scope` parses and the gatekeeper validates. A {@link Grant}
 * is just a set of scope permissions plus flag scopes; every view in the picker
 * (the plain-language sentences, the resource×action grid, the flag toggles) is a
 * projection of one `Grant`.
 *
 * Terminology maps 1:1 onto the Rust types:
 *
 * | this module            | `scopes-rust`                         |
 * | ---------------------- | ------------------------------------- |
 * | {@link Action} letters | `AccessRights` CRUDS bits             |
 * | {@link Access} `word`  | `AccessRights::{Read,Write,Star}` (v1)|
 * | {@link Access} `letters`| `AccessRights::Letters` (v2)         |
 * | {@link Context}        | `ContextLevel` + the `wildflower` ctx |
 * | {@link ScopePermission}| `FhirResourceScope`/`WildflowerResourceScope` |
 * | {@link FlagScope}      | `KnownScope`                          |
 */

/** A SMART v2 CRUDS permission letter. Canonical order is always `c r u d s`. */
export type Action = 'c' | 'r' | 'u' | 'd' | 's'

/** Canonical CRUDS order (SMART v2). Every letter list is sorted into this order. */
export const ACTION_ORDER: readonly Action[] = ['c', 'r', 'u', 'd', 's']

/**
 * The five user-facing verbs, strictly 1:1 with CRUDS (no merging, no
 * "view = read + search" collapse). See `spec.md §1`.
 */
export const VERB: Readonly<Record<Action, string>> = {
  c: 'Create',
  r: 'Read',
  u: 'Update',
  d: 'Destroy',
  s: 'Search',
}

/**
 * A SMART v1 access *word*. v1 clients can only express these three coarse
 * levels — never an arbitrary CRUDS subset — which is why a v1-form scope is
 * edited with a four-option select (None/Read/Write/Both) rather than the
 * per-letter grid. By CRUDS bits: `read` = `r,s`; `write` = `c,u,d`;
 * `star` (`*`) = all five. `read` and `write` partition `star`.
 */
export type AccessWord = 'read' | 'write' | 'star'

/**
 * The access rights of one scope, in the *form* the request used. Mirrors
 * `scopes-rust`'s `AccessRights`: a v1 word round-trips verbatim, a v2 letter
 * bag normalizes to canonical order. The form is load-bearing for the UI —
 * `'word'` scopes render the v1 fallback picker, `'letters'` scopes render the
 * CRUDS cells.
 */
export type Access =
  | { readonly form: 'letters'; readonly letters: readonly Action[] }
  | { readonly form: 'word'; readonly word: AccessWord }

/**
 * A scope context (the part before the `/`). `patient`/`user`/`system` are the
 * FHIR `ContextLevel`s; `wildflower` is the fixed context of the app's own admin
 * resources (Rust models these as a separate scope kind, unreachable by the FHIR
 * `*` wildcard).
 */
export type Context = 'patient' | 'user' | 'system' | 'wildflower'

/**
 * Subject contexts offered when the user builds a grant from scratch (open /
 * device mode). `user/` is deliberately excluded — it is only ever *shown* when
 * an app explicitly requests it, never offered as a free choice. `system`
 * (all patients) is the elevated, re-auth-gated choice.
 */
export const OFFERABLE_CONTEXTS: readonly Context[] = ['patient', 'system']

/**
 * One resource permission: a context, a FHIR/Wildflower resource type (or `'*'`
 * for the live wildcard), and the access granted on it. The `'*'` wildcard is a
 * *live* wildcard — it covers current and future resource types of that context
 * (`spec.md §4`), never a snapshot.
 */
export interface ScopePermission {
  readonly context: Context
  readonly resource: string
  readonly access: Access
}

/** The closed set of non-resource (flag) scopes — Rust's `KnownScope`. */
export type FlagScope =
  | 'openid'
  | 'profile'
  | 'fhirUser'
  | 'offline_access'
  | 'launch'
  | 'launch/patient'

/** The canonical flag scopes in display order (`spec.md §7`). */
export const FLAG_SCOPES: readonly FlagScope[] = [
  'openid',
  'profile',
  'fhirUser',
  'offline_access',
  'launch',
  'launch/patient',
]

/** The subject sentinel for an all-patients (`system/`) grant. */
export const ALL_PATIENTS = 'all'

/**
 * The single source of truth a picker edits. `subject` is a patient id for a
 * patient grant, or {@link ALL_PATIENTS} (`'all'`) for a `system/`
 * (all-patients) grant — which is elevated and re-auth gated (`spec.md §6`).
 * Every projection renders from this one object; no view holds its own copy of
 * permission state (`spec.md §5`).
 */
export interface Grant {
  readonly subject: string
  readonly permissions: readonly ScopePermission[]
  readonly flags: readonly FlagScope[]
}

/**
 * What an app asked for (request mode). The grant is clamped so that
 * `granted ⊆ requested` at all times (`spec.md §2`); `required` permissions are
 * locked on. Absence of an envelope ⇒ open mode (the user builds freely).
 */
export interface RequestEnvelope {
  readonly permissions: readonly (ScopePermission & { readonly required?: boolean })[]
  readonly flags: readonly { readonly scope: FlagScope; readonly required?: boolean }[]
}

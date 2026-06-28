/**
 * The canonical, framework-free scope model — a faithful TypeScript mirror of
 * `slices/scopes/scopes-rust`'s `Scope` model (`scope/mod.rs` and the
 * `scope/resource` + `scope/known` + `scope/unknown` modules). A {@link Grant}
 * is a `Vec<Scope>` (Rust has no Grant type — a grant is conceptually just a set
 * of scopes), so whatever the UI edits serializes back to the exact strings the
 * Rust `Scope` parses and the gatekeeper validates.
 *
 * | this module                | `scopes-rust`                  |
 * | -------------------------- | ------------------------------ |
 * | {@link Access}             | `AccessRights` / `Repr`        |
 * | {@link ContextLevel}       | `ContextLevel`                 |
 * | {@link ResourceType}       | `ResourceType`                 |
 * | {@link FhirResourceScope}  | `FhirResourceScope`            |
 * | {@link WildflowerResource} | `WildflowerResource`           |
 * | {@link WildflowerResourceScope} | `WildflowerResourceScope` |
 * | {@link KnownScope}         | `KnownScope`                   |
 * | {@link Scope}              | `Scope`                        |
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
 * The access rights of one scope — a faithful mirror of Rust's `AccessRights`
 * `Repr`. The SMART v1 words round-trip verbatim (`read` = r,s; `write` = c,u,d;
 * `star` = `*` = all five); a v2 `letters` bag normalizes to canonical order.
 * The variant is load-bearing for the UI — `letters` renders the CRUDS cells,
 * the words render the Read/Write multiselect.
 */
export type Access =
  | { readonly kind: 'read' }
  | { readonly kind: 'write' }
  | { readonly kind: 'star' }
  | { readonly kind: 'letters'; readonly letters: readonly Action[] }

/** A SMART on FHIR access level (Rust's `ContextLevel`). */
export type ContextLevel = 'patient' | 'user' | 'system'

/** The FHIR `ContextLevel`s in order. */
export const CONTEXT_LEVELS: readonly ContextLevel[] = ['patient', 'user', 'system']

/**
 * The FHIR resource type a scope addresses — `*` or a named type (Rust's
 * `ResourceType`). The wildcard is a *live* wildcard: it covers current and
 * future resource types of that context (`spec.md §4`), never a snapshot.
 */
export type ResourceType =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'known'; readonly name: string }

/** A SMART `context/Type.perms` FHIR resource scope (Rust's `FhirResourceScope`). */
export interface FhirResourceScope {
  readonly kind: 'fhir'
  readonly context: ContextLevel
  readonly resource: ResourceType
  readonly access: Access
}

/** A Wildflower-specific resource the gatekeeper governs (Rust's `WildflowerResource`). */
export type WildflowerResource = 'AuthorizationRequest' | 'Grant' | 'Client' | 'RefreshToken'

/** The closed set of Wildflower resources, in order. */
export const WILDFLOWER_RESOURCES: readonly WildflowerResource[] = [
  'AuthorizationRequest',
  'Grant',
  'Client',
  'RefreshToken',
]

/** The fixed context segment all Wildflower scopes share (`wildflower/...`). */
export const WILDFLOWER_CONTEXT = 'wildflower'

/** The resource a Wildflower scope addresses (Rust's `WildflowerResourceType`). */
export type WildflowerResourceType =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'known'; readonly resource: WildflowerResource }

/** A `wildflower/Resource.perms` scope (Rust's `WildflowerResourceScope`). */
export interface WildflowerResourceScope {
  readonly kind: 'wildflower'
  readonly resource: WildflowerResourceType
  readonly access: Access
}

/** A broadly-known non-resource (flag) scope (Rust's `KnownScope`). */
export type KnownScope =
  | 'openid'
  | 'profile'
  | 'fhirUser'
  | 'offline_access'
  | 'launch'
  | 'launch/patient'

/** The canonical flag scopes in display order (`spec.md §7`). */
export const KNOWN_SCOPES: readonly KnownScope[] = [
  'openid',
  'profile',
  'fhirUser',
  'offline_access',
  'launch',
  'launch/patient',
]

/**
 * An OAuth 2.0 / SMART on FHIR scope — the four-kind union mirroring Rust's
 * `Scope`. Parsing is total: an unrecognized string is preserved verbatim as
 * `unknown`, never dropped.
 */
export type Scope =
  | FhirResourceScope
  | WildflowerResourceScope
  | { readonly kind: 'known'; readonly scope: KnownScope }
  | { readonly kind: 'unknown'; readonly raw: string }

/** The two *resource* scope kinds — the editable ones (grid rows / consent statements). */
export type ResourceScope = FhirResourceScope | WildflowerResourceScope

/** The subject sentinel for an all-patients (`system/`) grant. */
export const ALL_PATIENTS = 'all'

/**
 * The single source of truth a picker edits: a subject plus a set of scopes (a
 * `Vec<Scope>`). `subject` is a patient id, or {@link ALL_PATIENTS} for a
 * `system/` grant. Every projection (the consent sentences, the resource grid,
 * the flag toggles) renders from this one object (`spec.md §5`).
 */
export interface Grant {
  readonly subject: string
  readonly scopes: readonly Scope[]
}

/**
 * Subject contexts offered when the user builds a grant from scratch (open /
 * device mode). `user/` is excluded — it is only ever *shown* when an app
 * requests it. `system` (all patients) is the elevated choice.
 */
export const OFFERABLE_CONTEXTS: readonly ContextLevel[] = ['patient', 'system']

/** A requested resource scope, with its `required` flag (request mode). */
export type RequestedResource = ResourceScope & { readonly required?: boolean }

/** A requested flag scope, with its `required` flag. */
export interface RequestedFlag {
  readonly scope: KnownScope
  readonly required?: boolean
}

/**
 * What an app asked for (request mode). The grant is clamped so that
 * `granted ⊆ requested` at all times (`spec.md §2`); `required` scopes are
 * locked on. Absence of an envelope ⇒ open mode (the user builds freely).
 */
export interface RequestEnvelope {
  readonly resources: readonly RequestedResource[]
  readonly flags: readonly RequestedFlag[]
}

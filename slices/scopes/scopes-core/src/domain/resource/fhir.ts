/**
 * The SMART on FHIR `context/Type.perms` resource scope and its parts, mirroring
 * `scopes-rust`'s `FhirResourceScope` / `ContextLevel` / `ResourceType`
 * (`scope/resource/fhir.rs`).
 *
 * Namespace module (`import { Fhir } from 'scopes-core'`): the scope value is
 * {@link FhirResourceScope}, with `Fhir.parse`, `Fhir.serialize`, `Fhir.ContextLevel`, …
 */

import * as AccessRights from './access-rights.ts'

/**
 * The access level a {@link FhirResourceScope} is relative to. `user` currently grants the
 * same as `system`, but the three are modeled and compared **strictly** —
 * `user` never silently means `system`.
 */
export type ContextLevel = 'patient' | 'user' | 'system'

/** The FHIR `ContextLevel`s in order. */
export const CONTEXT_LEVELS: readonly ContextLevel[] = ['patient', 'user', 'system']

/**
 * The FHIR resource type a scope addresses — `*` or a named type. The wildcard
 * is a *live* wildcard: it covers current and future resource types of that
 * context (`spec.md §4`), never a snapshot.
 */
export type ResourceType =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'known'; readonly name: string }

/** A SMART `context/Type.perms` FHIR resource scope. */
export type FhirResourceScope = {
  readonly kind: 'fhir'
  readonly context: ContextLevel
  readonly resource: ResourceType
  readonly access: AccessRights.AccessRights
}

const isContextLevel = (s: string): s is ContextLevel =>
  (CONTEXT_LEVELS as readonly string[]).includes(s)

/** Build a {@link ResourceType} from a type string (`*` → wildcard). */
export const resourceType = (name: string): ResourceType =>
  name === '*' ? { kind: 'wildcard' } : { kind: 'known', name }

/** The display/serialization name of a {@link ResourceType} (`*` or the type). */
export const resourceName = (resource: ResourceType): string =>
  resource.kind === 'wildcard' ? '*' : resource.name

/**
 * Parse the `context/Type.perms` FHIR grammar (context ∈
 * `patient`/`user`/`system`), or `null` if `s` isn't one.
 */
export const parse = (s: string): FhirResourceScope | null => {
  const slash = s.indexOf('/')
  if (slash <= 0) return null
  const ctx = s.slice(0, slash)
  if (!isContextLevel(ctx)) return null
  const rest = s.slice(slash + 1)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const access = AccessRights.parse(rest.slice(dot + 1))
  if (access === null) return null
  return { kind: 'fhir', context: ctx, resource: resourceType(rest.slice(0, dot)), access }
}

/** Render to its `context/Type.perms` string; a scope granting nothing emits `''`. */
export const serialize = (scope: FhirResourceScope): string => {
  const perms = AccessRights.serialize(scope.access)
  return perms === '' ? '' : `${scope.context}/${resourceName(scope.resource)}.${perms}`
}

/**
 * The SMART on FHIR `context/Type.perms` resource scope and its parts, mirroring
 * `scopes-rust`'s `FhirResourceScope` / `ContextLevel` / `ResourceType`
 * (`scope/resource/fhir.rs`).
 *
 * Namespace module (`import { Fhir } from 'scopes-core'`): the scope value is
 * {@link FhirResourceScope}, with `Fhir.scopeParse`, `Fhir.scopeSerialize`, `Fhir.ContextLevel`, …
 */

import type { ScopeParser, ScopeSerializer } from '../../behaviour/index.ts'
import * as AccessRights from './access-rights.ts'

/**
 * The access level a {@link FhirResourceScope} is relative to. `user` currently grants the
 * same as `system`, but the three are modeled and compared **strictly** —
 * `user` never silently means `system`.
 */
type ContextLevel = 'patient' | 'user' | 'system'

/** The FHIR `ContextLevel`s in order. */
const CONTEXT_LEVELS: readonly ContextLevel[] = ['patient', 'user', 'system']

/**
 * The FHIR resource type a scope addresses — `*` or a named type. The wildcard
 * is a *live* wildcard: it covers current and future resource types of that
 * context (`spec.md §4`), never a snapshot.
 */
type ResourceType =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'known'; readonly name: string }

/** A SMART `context/Type.perms` FHIR resource scope. */
type FhirResourceScope = {
  readonly kind: 'fhir'
  readonly context: ContextLevel
  readonly resource: ResourceType
  readonly access: AccessRights.AccessRights
}

const isContextLevel = (s: string): s is ContextLevel =>
  (CONTEXT_LEVELS as readonly string[]).includes(s)

/** Build a {@link ResourceType} from a type string (`*` → wildcard). */
const resourceType = (name: string): ResourceType =>
  name === '*' ? { kind: 'wildcard' } : { kind: 'known', name }

/** The display/serialization name of a {@link ResourceType} (`*` or the type). */
const resourceName = (resource: ResourceType): string =>
  resource.kind === 'wildcard' ? '*' : resource.name

/**
 * Parse the `context/Type.perms` FHIR grammar (context ∈
 * `patient`/`user`/`system`), or `null` if `s` isn't one.
 */
const scopeParse: ScopeParser<FhirResourceScope>['scopeParse'] = (s) => {
  const slash = s.indexOf('/')
  if (slash <= 0) return null
  const ctx = s.slice(0, slash)
  if (!isContextLevel(ctx)) return null
  const rest = s.slice(slash + 1)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const access = AccessRights.scopeParse(rest.slice(dot + 1))
  if (access === null) return null
  return { kind: 'fhir', context: ctx, resource: resourceType(rest.slice(0, dot)), access }
}

/** Render to its `context/Type.perms` string; a scope granting nothing emits `''`. */
const scopeSerialize: ScopeSerializer<FhirResourceScope>['scopeSerialize'] = (scope) => {
  const perms = AccessRights.scopeSerialize(scope.access)
  return perms === '' ? '' : `${scope.context}/${resourceName(scope.resource)}.${perms}`
}

export {
  type ContextLevel,
  CONTEXT_LEVELS,
  type ResourceType,
  type FhirResourceScope,
  resourceType,
  resourceName,
  scopeParse,
  scopeSerialize,
}

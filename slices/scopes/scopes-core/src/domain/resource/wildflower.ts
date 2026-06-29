/**
 * The `wildflower/Resource.perms` admin resource scope and its parts, mirroring
 * `scopes-rust`'s `WildflowerResource` / `WildflowerResourceScope` /
 * `WildflowerResourceType` (`scope/resource/wildflower.rs`). These resources are
 * **not** reachable through the FHIR `*` wildcard — the set is closed.
 *
 * Namespace module (`import { Wildflower } from 'scopes-core'`): the scope value
 * is {@link WildflowerResourceScope}, with `Wildflower.scopeParse`, `Wildflower.Resource`, …
 */

import type { ScopeParser, ScopeSerializer } from '../../behaviour/index.ts'
import * as AccessRights from './access-rights.ts'

/** A Wildflower-specific resource the gatekeeper governs (Rust's `WildflowerResource`). */
export type Resource = 'AuthorizationRequest' | 'Grant' | 'Client' | 'RefreshToken'

/** The closed set of Wildflower resources, in order. */
export const RESOURCES: readonly Resource[] = [
  'AuthorizationRequest',
  'Grant',
  'Client',
  'RefreshToken',
]

/** The fixed context segment all Wildflower scopes share (`wildflower/...`). */
export const CONTEXT = 'wildflower'

/** The resource a Wildflower scope addresses (Rust's `WildflowerResourceType`). */
export type ResourceType =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'known'; readonly resource: Resource }

/** A `wildflower/Resource.perms` scope (Rust's `WildflowerResourceScope`). */
export type WildflowerResourceScope = {
  readonly kind: 'wildflower'
  readonly resource: ResourceType
  readonly access: AccessRights.AccessRights
}

/** Build a {@link ResourceType} from a name, or `null` for an unknown resource (the set is closed). */
export const resourceType = (name: string): ResourceType | null => {
  if (name === '*') return { kind: 'wildcard' }
  const resource = RESOURCES.find((r) => r === name)
  return resource === undefined ? null : { kind: 'known', resource }
}

/** The display/serialization name of a {@link ResourceType} (`*` or the resource). */
export const resourceName = (resource: ResourceType): string =>
  resource.kind === 'wildcard' ? '*' : resource.resource

/** Parse the `wildflower/Resource.perms` grammar, or `null` if `s` isn't one. */
export const scopeParse: ScopeParser<WildflowerResourceScope>['scopeParse'] = (s) => {
  const slash = s.indexOf('/')
  if (slash <= 0) return null
  if (s.slice(0, slash) !== CONTEXT) return null
  const rest = s.slice(slash + 1)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const resource = resourceType(rest.slice(0, dot))
  if (resource === null) return null
  const access = AccessRights.scopeParse(rest.slice(dot + 1))
  if (access === null) return null
  return { kind: 'wildflower', resource, access }
}

/** Render to its `wildflower/Resource.perms` string; a scope granting nothing emits `''`. */
export const scopeSerialize: ScopeSerializer<WildflowerResourceScope>['scopeSerialize'] = (
  scope
) => {
  const perms = AccessRights.scopeSerialize(scope.access)
  return perms === '' ? '' : `${CONTEXT}/${resourceName(scope.resource)}.${perms}`
}

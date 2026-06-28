/**
 * Constructors and accessors for the {@link Scope} union and the *bucket*
 * addressing the grid/consent views use. A bucket groups the resource scopes
 * the user edits together: a FHIR {@link ContextLevel}, or the Wildflower admin
 * kind. The model stays faithful to `scopes-rust` (tagged `ResourceType`,
 * closed `WildflowerResource`); buckets + resource *names* are the view-side
 * convenience over it.
 */

import type {
  Access,
  ContextLevel,
  KnownScope,
  ResourceScope,
  ResourceType,
  Scope,
  WildflowerResourceType,
} from './model.ts'
import { WILDFLOWER_RESOURCES } from './model.ts'

// ── resource-type names / constructors ──────────────────────────────────────

/** The display/serialization name of a FHIR resource type (`*` or the type). */
export const fhirResourceName = (resource: ResourceType): string =>
  resource.kind === 'wildcard' ? '*' : resource.name

/** The display/serialization name of a Wildflower resource type (`*` or the name). */
export const wildflowerResourceName = (resource: WildflowerResourceType): string =>
  resource.kind === 'wildcard' ? '*' : resource.resource

/** The resource name of either resource-scope kind. */
export const resourceScopeName = (scope: ResourceScope): string =>
  scope.kind === 'fhir' ? fhirResourceName(scope.resource) : wildflowerResourceName(scope.resource)

/** Build a FHIR {@link ResourceType} from a name (`*` ⇒ wildcard). */
export const fhirResourceType = (name: string): ResourceType =>
  name === '*' ? { kind: 'wildcard' } : { kind: 'known', name }

/** Build a Wildflower {@link WildflowerResourceType}, or `null` for an unknown name. */
export const wildflowerResourceType = (name: string): WildflowerResourceType | null => {
  if (name === '*') return { kind: 'wildcard' }
  const resource = WILDFLOWER_RESOURCES.find((r) => r === name)
  return resource === undefined ? null : { kind: 'known', resource }
}

// ── buckets ─────────────────────────────────────────────────────────────────

/** A group of resource scopes edited together: a FHIR context, or Wildflower admin. */
export type Bucket =
  | { readonly kind: 'fhir'; readonly context: ContextLevel }
  | { readonly kind: 'wildflower' }

/** A FHIR bucket for a context level. */
export const fhirBucket = (context: ContextLevel): Bucket => ({ kind: 'fhir', context })

/** The Wildflower admin bucket. */
export const wildflowerBucket: Bucket = { kind: 'wildflower' }

/** Whether a resource scope belongs to a bucket. */
export const inBucket = (scope: ResourceScope, bucket: Bucket): boolean =>
  bucket.kind === 'fhir'
    ? scope.kind === 'fhir' && scope.context === bucket.context
    : scope.kind === 'wildflower'

/**
 * Build a {@link ResourceScope} in a bucket from a resource name + access, or
 * `null` if the name isn't a valid resource for that bucket (the Wildflower set
 * is closed).
 */
export const makeResourceScope = (
  bucket: Bucket,
  name: string,
  access: Access
): ResourceScope | null => {
  if (bucket.kind === 'fhir') {
    return { kind: 'fhir', context: bucket.context, resource: fhirResourceType(name), access }
  }
  const resource = wildflowerResourceType(name)
  return resource === null ? null : { kind: 'wildflower', resource, access }
}

// ── grant scope accessors ───────────────────────────────────────────────────

const isResourceScope = (scope: Scope): scope is ResourceScope =>
  scope.kind === 'fhir' || scope.kind === 'wildflower'

/** The resource scopes (FHIR + Wildflower) in a scope list. */
export const resourceScopes = (scopes: readonly Scope[]): ResourceScope[] =>
  scopes.filter(isResourceScope)

/** The flag (Known) scopes in a scope list. */
export const flagScopes = (scopes: readonly Scope[]): KnownScope[] => {
  const out: KnownScope[] = []
  for (const scope of scopes) if (scope.kind === 'known') out.push(scope.scope)
  return out
}

/** The unrecognized scopes, preserved verbatim. */
export const unknownScopes = (scopes: readonly Scope[]): string[] => {
  const out: string[] = []
  for (const scope of scopes) if (scope.kind === 'unknown') out.push(scope.raw)
  return out
}

/** Find the resource scope for a (bucket, resource name), if granted. */
export const findResource = (
  scopes: readonly Scope[],
  bucket: Bucket,
  name: string
): ResourceScope | undefined =>
  resourceScopes(scopes).find((s) => inBucket(s, bucket) && resourceScopeName(s) === name)

/** The same-bucket `*` wildcard resource scope, if any. */
export const findWildcard = (scopes: readonly Scope[], bucket: Bucket): ResourceScope | undefined =>
  findResource(scopes, bucket, '*')

/** Whether the grant holds a given flag scope. */
export const hasFlag = (scopes: readonly Scope[], flag: KnownScope): boolean =>
  scopes.some((s) => s.kind === 'known' && s.scope === flag)

// ── scope constructors ──────────────────────────────────────────────────────

/** A flag (Known) scope. */
export const knownScope = (scope: KnownScope): Scope => ({ kind: 'known', scope })

/** A preserved unknown scope. */
export const unknownScope = (raw: string): Scope => ({ kind: 'unknown', raw })

/**
 * Scope-string serialization and parsing. Round-trips the grammar in
 * `scopes-rust` (`scope/mod.rs`): `context/Type.perms` FHIR scopes,
 * `wildflower/Resource.perms` admin scopes, the closed set of flag scopes, and
 * an `unknown` fallback. Parsing is total — an unrecognized string is preserved
 * verbatim, never dropped.
 */

import { accessLetters, lettersAccess, parseAccess, serializeAccess } from './access.ts'
import type { Access, ContextLevel, Grant, KnownScope, ResourceScope, Scope } from './model.ts'
import { CONTEXT_LEVELS, KNOWN_SCOPES, WILDFLOWER_CONTEXT } from './model.ts'
import {
  fhirResourceType,
  findWildcard,
  fhirBucket,
  flagScopes,
  resourceScopeName,
  resourceScopes,
  unknownScopes,
  wildflowerBucket,
  wildflowerResourceType,
  type Bucket,
} from './scope.ts'

const isKnownScope = (s: string): s is KnownScope => (KNOWN_SCOPES as readonly string[]).includes(s)
const isContextLevel = (s: string): s is ContextLevel =>
  (CONTEXT_LEVELS as readonly string[]).includes(s)

const scopeContextPrefix = (scope: ResourceScope): string =>
  scope.kind === 'fhir' ? scope.context : WILDFLOWER_CONTEXT

/** The context prefix of a bucket (`patient`/`user`/`system`/`wildflower`). */
export const bucketPrefix = (bucket: Bucket): string =>
  bucket.kind === 'fhir' ? bucket.context : WILDFLOWER_CONTEXT

/** Serialize one scope to its string form; resource scopes that grant nothing emit `''`. */
export const serializeScope = (scope: Scope): string => {
  switch (scope.kind) {
    case 'known':
      return scope.scope
    case 'unknown':
      return scope.raw
    case 'fhir':
    case 'wildflower': {
      const perms = serializeAccess(scope.access)
      return perms === '' ? '' : `${scopeContextPrefix(scope)}/${resourceScopeName(scope)}.${perms}`
    }
    default: {
      const exhaustive: never = scope
      throw new Error(`unknown scope kind: ${String(exhaustive)}`)
    }
  }
}

/** Parse one scope string into its richest form — total (mirrors Rust's `Scope`). */
export const parseScope = (scope: string): Scope => {
  if (isKnownScope(scope)) return { kind: 'known', scope }
  const slash = scope.indexOf('/')
  if (slash > 0) {
    const ctx = scope.slice(0, slash)
    const rest = scope.slice(slash + 1)
    const dot = rest.lastIndexOf('.')
    if (dot > 0) {
      const name = rest.slice(0, dot)
      const access = parseAccess(rest.slice(dot + 1))
      if (access !== null) {
        if (ctx === WILDFLOWER_CONTEXT) {
          const resource = wildflowerResourceType(name)
          if (resource !== null) return { kind: 'wildflower', resource, access }
        } else if (isContextLevel(ctx)) {
          return { kind: 'fhir', context: ctx, resource: fhirResourceType(name), access }
        }
      }
    }
  }
  return { kind: 'unknown', raw: scope }
}

/** Parse a resource scope (FHIR or Wildflower), or `null` for a flag/unknown. */
export const parseResourceScope = (scope: string): ResourceScope | null => {
  const parsed = parseScope(scope)
  return parsed.kind === 'fhir' || parsed.kind === 'wildflower' ? parsed : null
}

/**
 * Serialize a grant's resource scopes with wildcard dedupe (`spec.md §3`): a
 * specific scope omits actions already covered by its same-bucket wildcard, and
 * is dropped entirely when the wildcard covers it. Returns a sorted, deduped
 * array of resource scope strings.
 */
export const serializeGrant = (grant: Grant): string[] => {
  const out: string[] = []
  for (const scope of resourceScopes(grant.scopes)) {
    const name = resourceScopeName(scope)
    if (name === '*') {
      const s = serializeScope(scope)
      if (s !== '') out.push(s)
      continue
    }
    const bucket: Bucket = scope.kind === 'fhir' ? fhirBucket(scope.context) : wildflowerBucket
    const wildcard = findWildcard(grant.scopes, bucket)
    if (wildcard === undefined) {
      const s = serializeScope(scope)
      if (s !== '') out.push(s)
      continue
    }
    const covered = new Set(accessLetters(wildcard.access))
    const own = accessLetters(scope.access)
    if (own.every((a) => covered.has(a))) continue // fully covered by the wildcard
    if (scope.access.kind === 'letters') {
      const remaining = own.filter((a) => !covered.has(a))
      const s = serializeScope({ ...scope, access: lettersAccess(remaining) })
      if (s !== '') out.push(s)
    } else {
      // A v1 word only partially covered can't be cleanly subtracted; emit it
      // whole (redundant emission is harmless, just less tidy).
      const s = serializeScope(scope)
      if (s !== '') out.push(s)
    }
  }
  return [...new Set(out)].toSorted()
}

/** The full scope list a grant emits — resource scopes (deduped) + flags + preserved unknowns. */
export const serializeAll = (grant: Grant): string[] => [
  ...serializeGrant(grant),
  ...flagScopes(grant.scopes).toSorted(),
  ...unknownScopes(grant.scopes).toSorted(),
]

/** The live scope string for a (bucket, resource, access) — for grid `code` display. */
export const scopeCode = (bucket: Bucket, name: string, access: Access): string => {
  const perms = serializeAccess(access)
  return perms === ''
    ? `${bucketPrefix(bucket)}/${name}`
    : `${bucketPrefix(bucket)}/${name}.${perms}`
}

/**
 * Scope-string serialization and parsing. Round-trips the grammar in
 * `scopes-rust` (`scope/mod.rs`): `context/Type.perms` resource scopes and the
 * closed set of flag scopes. Parsing is total — an unrecognized string is
 * preserved verbatim as `unknown`, never dropped.
 */

import { accessLetters, parseAccess, serializeAccess } from './access.ts'
import type { Access, Context, FlagScope, Grant, ScopePermission } from './model.ts'
import { FLAG_SCOPES } from './model.ts'

const CONTEXTS: readonly Context[] = ['patient', 'user', 'system', 'wildflower']

const isContext = (s: string): s is Context => (CONTEXTS as readonly string[]).includes(s)

const isFlagScope = (s: string): s is FlagScope => (FLAG_SCOPES as readonly string[]).includes(s)

/** The result of parsing one scope string — total, mirroring Rust's `Scope`. */
export type ParsedScope =
  | { readonly kind: 'flag'; readonly flag: FlagScope }
  | { readonly kind: 'resource'; readonly permission: ScopePermission }
  | { readonly kind: 'unknown'; readonly raw: string }

/** Parse one scope string into its richest form (flag → resource → unknown). */
export const parseScope = (scope: string): ParsedScope => {
  if (isFlagScope(scope)) return { kind: 'flag', flag: scope }
  const slash = scope.indexOf('/')
  if (slash > 0) {
    const context = scope.slice(0, slash)
    const rest = scope.slice(slash + 1)
    const dot = rest.lastIndexOf('.')
    if (isContext(context) && dot > 0) {
      const resource = rest.slice(0, dot)
      const access = parseAccess(rest.slice(dot + 1))
      if (access !== null) return { kind: 'resource', permission: { context, resource, access } }
    }
  }
  return { kind: 'unknown', raw: scope }
}

/** Parse a resource scope into a {@link ScopePermission}, or `null` otherwise. */
export const parsePermission = (scope: string): ScopePermission | null => {
  const parsed = parseScope(scope)
  return parsed.kind === 'resource' ? parsed.permission : null
}

/** Serialize one permission to `context/Resource.perms`, or `''` if it grants nothing. */
export const serializePermission = (permission: ScopePermission): string => {
  const perms = serializeAccess(permission.access)
  return perms === '' ? '' : `${permission.context}/${permission.resource}.${perms}`
}

/**
 * The same-context `*` wildcard permission for `permission`, if any. The
 * `wildflower` admin context has its own wildcard, separate from the FHIR ones.
 */
const wildcardFor = (
  permissions: readonly ScopePermission[],
  permission: ScopePermission
): ScopePermission | undefined =>
  permissions.find((p) => p.context === permission.context && p.resource === '*')

/**
 * Serialize a grant's resource permissions with wildcard dedupe (`spec.md §3`):
 * a specific scope omits actions already covered by its same-context wildcard,
 * and is dropped entirely when the wildcard covers it. Returns a sorted, deduped
 * array of resource scope strings.
 */
export const serializeGrant = (grant: Grant): string[] => {
  const out: string[] = []
  for (const permission of grant.permissions) {
    if (permission.resource === '*') {
      const s = serializePermission(permission)
      if (s !== '') out.push(s)
      continue
    }
    const wildcard = wildcardFor(grant.permissions, permission)
    if (wildcard === undefined) {
      const s = serializePermission(permission)
      if (s !== '') out.push(s)
      continue
    }
    const covered = new Set(accessLetters(wildcard.access))
    const own = accessLetters(permission.access)
    if (own.every((a) => covered.has(a))) continue // fully covered by the wildcard
    if (permission.access.form === 'letters') {
      const remaining = own.filter((a) => !covered.has(a))
      const s = serializePermission({
        ...permission,
        access: { form: 'letters', letters: remaining },
      })
      if (s !== '') out.push(s)
    } else {
      // A v1 word only partially covered can't be cleanly subtracted; emit it
      // whole (redundant emission is harmless, just less tidy).
      const s = serializePermission(permission)
      if (s !== '') out.push(s)
    }
  }
  return [...new Set(out)].toSorted()
}

/** The full scope list a grant emits — resource scopes plus sorted flag scopes. */
export const serializeAll = (grant: Grant): string[] => [
  ...serializeGrant(grant),
  ...[...grant.flags].toSorted(),
]

/** The live scope string for one (context, resource, access) — for grid `code` display. */
export const scopeCode = (context: Context, resource: string, access: Access): string =>
  serializePermission({ context, resource, access })

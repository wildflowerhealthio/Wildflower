/**
 * Broadly-known non-resource (flag) scopes — `openid`, `offline_access`, the
 * launch-context scopes — mirroring `scopes-rust`'s `KnownScope`
 * (`scope/known.rs`). These match exactly; they are never resource scopes.
 *
 * Namespace module (`import { KnownScope } from 'scopes-core'`): the enum is
 * {@link Any}, with `KnownScope.parse`, `KnownScope.is`, `KnownScope.ALL`.
 */

/** A broadly-known non-resource scope that matches exactly (Rust's `KnownScope`). */
export type Any = 'openid' | 'profile' | 'fhirUser' | 'offline_access' | 'launch' | 'launch/patient'

/** The canonical flag scopes in display order (`spec.md §7`). */
export const ALL: readonly Any[] = [
  'openid',
  'profile',
  'fhirUser',
  'offline_access',
  'launch',
  'launch/patient',
]

/** Whether a string is a known flag scope. */
export const is = (s: string): s is Any => (ALL as readonly string[]).includes(s)

/** Parse a known flag scope, or `null` if `s` isn't one. */
export const parse = (s: string): Any | null => (is(s) ? s : null)

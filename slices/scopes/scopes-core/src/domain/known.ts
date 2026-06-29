/**
 * Broadly-known non-resource (flag) scopes — `openid`, `offline_access`, the
 * launch-context scopes — mirroring `scopes-rust`'s `KnownScope`
 * (`scope/known.rs`). These match exactly; they are never resource scopes.
 *
 * Namespace module (`import { KnownScope } from 'scopes-core'`): the enum is
 * {@link KnownScope}, with `KnownScope.scopeParse`, `KnownScope.is`, `KnownScope.ALL`.
 */

import type { ScopeParser } from '../behaviour/index.ts'

/** A broadly-known non-resource scope that matches exactly (Rust's `KnownScope`). */
type KnownScope = 'openid' | 'profile' | 'fhirUser' | 'offline_access' | 'launch' | 'launch/patient'

/** The canonical flag scopes in display order (`spec.md §7`). */
const ALL: readonly KnownScope[] = [
  'openid',
  'profile',
  'fhirUser',
  'offline_access',
  'launch',
  'launch/patient',
]

/** Whether a string is a known flag scope. */
const is = (s: string): s is KnownScope => (ALL as readonly string[]).includes(s)

/** Parse a known flag scope, or `null` if `s` isn't one. */
const scopeParse: ScopeParser<KnownScope>['scopeParse'] = (s) => (is(s) ? s : null)

export { type KnownScope, ALL, is, scopeParse }

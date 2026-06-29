/**
 * The structured, owned {@link Scope} scope model — the four-kind union mirroring
 * `scopes-rust`'s `Scope` (`scope/mod.rs`). Parsing is **total** (an
 * unrecognized string falls back to `unknown`, never dropped) and prefers the
 * richest representation; rendering round-trips.
 *
 * Namespace module (`import { Scope } from 'scopes-core'`): the union is
 * {@link Scope}, with `Scope.parse`, `Scope.serialize`, `Scope.Resource`, …
 */

import * as KnownScope from './known.ts'
import * as Fhir from './resource/fhir.ts'
import * as Wildflower from './resource/wildflower.ts'
import * as UnknownScope from './unknown.ts'

/** The known-scope (flag) variant of the union (`Scope::Known` in Rust). */
export type Known = { readonly kind: 'known'; readonly scope: KnownScope.KnownScope }

/**
 * An OAuth 2.0 / SMART on FHIR scope — the four-kind union mirroring Rust's
 * `Scope`. Parsing is total: an unrecognized string is preserved verbatim as
 * `unknown`, never dropped.
 */
export type Scope =
  | Fhir.FhirResourceScope
  | Wildflower.WildflowerResourceScope
  | Known
  | UnknownScope.UnknownScope

/** The two *resource* scope kinds — the editable ones (grid rows / consent statements). */
export type Resource = Fhir.FhirResourceScope | Wildflower.WildflowerResourceScope

/** A flag (Known) scope. */
export const known = (scope: KnownScope.KnownScope): Scope => ({ kind: 'known', scope })

/** A preserved unknown scope. */
export const unknown = (raw: string): Scope => UnknownScope.make(raw)

/** Whether a scope is a resource scope (FHIR or Wildflower). */
export const isResource = (scope: Scope): scope is Resource =>
  scope.kind === 'fhir' || scope.kind === 'wildflower'

/** The display name of a resource scope's type (`*` or the type/resource name). */
export const resourceName = (scope: Resource): string =>
  scope.kind === 'fhir'
    ? Fhir.resourceName(scope.resource)
    : Wildflower.resourceName(scope.resource)

/**
 * Parse one scope string into its richest form — total (mirrors Rust's
 * `Scope::from`): known → wildflower → FHIR → unknown.
 */
export const parse = (s: string): Scope => {
  const flag = KnownScope.parse(s)
  if (flag !== null) return { kind: 'known', scope: flag }
  const wf = Wildflower.parse(s)
  if (wf !== null) return wf
  const fhir = Fhir.parse(s)
  if (fhir !== null) return fhir
  return UnknownScope.make(s)
}

/** Parse a resource scope (FHIR or Wildflower), or `null` for a flag/unknown. */
export const parseResource = (s: string): Resource | null => {
  const parsed = parse(s)
  return isResource(parsed) ? parsed : null
}

/** Serialize one scope to its string form; resource scopes that grant nothing emit `''`. */
export const serialize = (scope: Scope): string => {
  switch (scope.kind) {
    case 'fhir':
      return Fhir.serialize(scope)
    case 'wildflower':
      return Wildflower.serialize(scope)
    case 'known':
      return scope.scope
    case 'unknown':
      return scope.raw
    default: {
      const exhaustive: never = scope
      throw new Error(`unknown scope kind: ${String(exhaustive)}`)
    }
  }
}

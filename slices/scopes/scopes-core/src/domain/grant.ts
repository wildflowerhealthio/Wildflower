/**
 * The {@link Grant} grant — an ordered set of {@link Scope}s, the structured form
 * of the scope lists callers store, transmit, and check coverage against
 * (mirrors `scopes-rust`'s `Grant`, `scope/grant.rs`). Parsing is **total** (each
 * string parses to its richest scope, never dropped) and rendering round-trips.
 *
 * The kind projections answer "what's in this grant?" without the caller
 * re-deriving them from a raw `Scope[]`. The editable, subject-bearing picker
 * state — and the ScopeContext-aware wildcard dedupe — live in the view-model
 * ({@link GrantDraft}), not here.
 *
 * Namespace module (`import { Grant } from 'scopes-core'`): the grant is
 * {@link Grant}, with `Grant.parse`, `Grant.render`, `Grant.resourceScopes`, …
 */

import type * as KnownScope from './known.ts'
import * as Scope from './scope.ts'

/** An ordered set of {@link Scope}s — a parsed grant, in its original order. */
export type Grant = { readonly scopes: readonly Scope.Scope[] }

/** A grant over the given scopes. */
export const make = (scopes: readonly Scope.Scope[]): Grant => ({ scopes })

/**
 * Parse a list of scope strings into a grant — total (each string parses to its
 * richest {@link Scope}, falling back to `unknown`, so no input is ever dropped).
 */
export const parse = (raw: Iterable<string>): Grant => ({
  scopes: [...raw].map((s) => Scope.scopeParse(s)),
})

/**
 * Render every scope to its canonical wire string — the list-level counterpart of
 * {@link Scope.scopeSerialize} (mirrors Rust's `Grant::render`). Order is preserved;
 * the view-model's {@link GrantDraft.serialize} layers wildcard dedupe (`spec.md §3`)
 * on top.
 */
export const render = (grant: Grant): string[] => grant.scopes.map((s) => Scope.scopeSerialize(s))

/** The resource scopes (FHIR + Wildflower) in a scope list. */
export const resourceScopes = (scopes: readonly Scope.Scope[]): Scope.Resource[] =>
  scopes.filter(Scope.isResource)

/** The known (flag) scopes in a scope list, e.g. `openid` / `offline_access`. */
export const knownScopes = (scopes: readonly Scope.Scope[]): KnownScope.KnownScope[] => {
  const out: KnownScope.KnownScope[] = []
  for (const s of scopes) if (s.kind === 'known') out.push(s.scope)
  return out
}

/** The unrecognized scopes, preserved verbatim. */
export const unknownScopes = (scopes: readonly Scope.Scope[]): string[] => {
  const out: string[] = []
  for (const s of scopes) if (s.kind === 'unknown') out.push(s.raw)
  return out
}

/** Whether the scope list holds a given known (flag) scope. */
export const hasKnown = (scopes: readonly Scope.Scope[], flag: KnownScope.KnownScope): boolean =>
  scopes.some((s) => s.kind === 'known' && s.scope === flag)

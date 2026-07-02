/**
 * The {@link Grant} grant — an ordered set of {@link Scope}s, the structured form
 * of the scope lists callers store, transmit, and check coverage against
 * (mirrors `scopes-rust`'s `Grant`, `scope/grant.rs`). Parsing is **total** (each
 * string parses to its richest scope, never dropped) and rendering round-trips.
 *
 * The kind projections answer "what's in this grant?" without the caller
 * re-deriving them from a raw `Scope[]`. The editable, patient-bearing picker
 * state — and the ScopeContext-aware wildcard dedupe — live in the view-model
 * ({@link GrantDraft}), not here.
 *
 * Namespace module (`import { Grant } from 'scopes-core'`): the grant is
 * {@link Grant}, with `Grant.parse`, `Grant.render`, `Grant.resourceScopes`, …
 */

import { Equal, pipe, Array } from 'effect'
import * as Scope from './scope/index.ts'

/** An ordered set of {@link Scope}s — a parsed grant, in its original order. A {@link Scope.MultiScope}. */
type Grant = Scope.MultiScope

/** A grant over the given scopes. */
const make = (scopes: readonly Scope.Any[]): Grant => ({
  unknown: [],
  known: [],
  fhirV1: [],
  fhirV2: [],
  wildflower: [],
  ...Array.groupBy(scopes, (s) => s.kind),
})
/**
 * Parse a list of scope strings into a grant — total (each string parses to its
 * richest {@link Scope}, falling back to `unknown`, so no input is ever dropped).
 */
const parse = (raw: Iterable<string>): Grant =>
  pipe(
    [...raw].map(
      (s): Scope.Any => Scope.ResourceScope.parse(s) ?? Scope.Known.parse(s) ?? new Scope.Unknown(s)
    ),
    make
  )

/**
 * Render every scope to its canonical wire string — the list-level counterpart of
 * {@link Scope.serialize} (mirrors Rust's `Grant::render`). Order is preserved;
 * the view-model's {@link GrantDraft.serialize} layers wildcard dedupe (`spec.md §3`)
 * on top.
 */
const render = (grant: Grant): string[] =>
  [...grant.unknown, ...grant.known, ...grant.fhirV1, ...grant.fhirV2, ...grant.wildflower]
    .map((s) => s.serialize())
    .filter((s): s is string => s !== null && s !== '')

/** The resource scopes (FHIR + Wildflower) in a scope list — the {@link Scope.MultiScope} fold. */
const resourceScopes = Scope.MultiScope.resourceScopes

/** Whether the scope list holds a given known (flag) scope. */
const hasKnown = (scopes: readonly Scope.Base[], scope: Scope.Known): boolean =>
  scopes.some(Equal.equals(scope))

export { type Grant, make, parse, render, resourceScopes, hasKnown }

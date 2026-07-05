/**
 * The {@link Rows} builder — the request-aware row list for one grid section (a single
 * scope variant + context over a catalog of resource names). It owns the row *policy*
 * every surface listing rows must agree on — which rows appear (including when the `*`
 * wildcard row is injected, `spec.md §2/§3`) and each cell's resolved state — so a
 * presenter ({@link buildGrid} in `scopes-react`, a future admin editor, …) only maps
 * rows to markup and copy. Cells resolve through one shared {@link Cell.resolver} per
 * section (the partitions are folded once, not once per cell). A view-model concern
 * with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Rows } from 'scopes-core'`).
 */

import { Equal } from 'effect'

import { Scope } from '../domain/index.ts'
import * as Cell from './cell.ts'
import type * as ScopeRequest from './scope-request.ts'

/** One resolved row of a grid section: its resource, stored scope, and O(1) cell lookup. */
type Row<K extends Scope.MultiScope.Kind> = {
  /** The row's resource (`Observation`, the `*` wildcard, …). */
  readonly resource: Scope.MultiScope.ResourceOf<K>
  /** Whether this is the injected `*` wildcard row. */
  readonly isWildcard: boolean
  /** The first stored grant row for (context, resource) — the live scope string's source. */
  readonly stored: Scope.MultiScope.ScopeOf<K> | undefined
  /** This row's resolved cell for one interaction — O(1) per lookup. */
  readonly cellFor: (itemId: Scope.MultiScope.InteractionOf<K>) => Cell.Cell
}

/** Options for {@link build}. */
type Options = {
  /**
   * Offer the `*` wildcard row where the mode allows it: always in open mode, and in
   * request mode only when the app itself requested a wildcard scope at this exact
   * context (`patient/*.…` shows the `*` row in the patient section only).
   */
  readonly includeWildcard?: boolean
}

/**
 * Build the resolved rows for one section: each catalog resource becomes a {@link Row}
 * (a name the variant can't parse is skipped), preceded by the `*` wildcard row when
 * {@link Options.includeWildcard} applies. `scopeRequest` is `null` for open mode.
 */
const build = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ConfigurationFor<K>,
  grant: Scope.MultiScope,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  context: Scope.MultiScope.ContextOf<K>,
  catalog: readonly string[],
  { includeWildcard = false }: Options = {}
): readonly Row<K>[] => {
  const cellFor = Cell.resolver(configuration, grant, scopeRequest, context)
  const wildcardResource = configuration.resourceClass.wildcardResourceType

  // The first stored grant row per resource (exact context) — folded once, so the
  // per-row lookup doesn't re-scan the partition.
  const stored = new Map<string, Scope.MultiScope.ScopeOf<K>>()
  for (const scope of Scope.MultiScope.partition(grant, configuration.id)) {
    if (!scope.hasContext(context)) continue
    const key = scope.resource.serialize()
    if (!stored.has(key)) stored.set(key, scope)
  }

  const rowFor = (resource: Scope.MultiScope.ResourceOf<K>): Row<K> => ({
    resource,
    isWildcard: wildcardResource !== undefined && Equal.equals(resource, wildcardResource),
    stored: stored.get(resource.serialize()),
    cellFor: (itemId) => cellFor(resource, itemId),
  })

  const rows = catalog
    .map((name) => configuration.resourceClass.parse(name))
    .filter((resource): resource is Scope.MultiScope.ResourceOf<K> => resource !== null)
    .map(rowFor)

  // §2/§3 wildcard-row policy: open mode always offers it (when the variant has a
  // wildcard at all); request mode only when the app requested a `*` scope at this
  // exact context (granting it stays within the envelope — without it, a requested
  // wildcard could never be granted as such).
  const wildcardOffered =
    includeWildcard &&
    wildcardResource !== undefined &&
    (scopeRequest === null ||
      Scope.MultiScope.partition(scopeRequest.requested, configuration.id).some(
        (scope) => scope.hasContext(context) && scope.hasResource(wildcardResource)
      ))
  return wildcardOffered ? [rowFor(wildcardResource), ...rows] : rows
}

export { type Row, type Options, build }

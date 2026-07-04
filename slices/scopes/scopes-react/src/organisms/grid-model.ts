/**
 * The view-model for {@link PermissionGrid}: it projects one {@link Section} — a single
 * scope variant, its context, and the resource rows it lists — over the editable
 * {@link GrantDraft.GrantDraft} into a {@link Grid} (its columns + rows). The §2/§3
 * decisions live in `scopes-core` ({@link Cell.forItem}); this file is pure projection,
 * DOM-free and unit-tested on its own.
 */

import { Cell } from 'scopes-core'
import type { Scope, GrantDraft, ScopeRequest } from 'scopes-core'

import type { PickerItem } from '../molecules/permission-picker.tsx'

/** One selectable control on a grid row — a permission item plus its resolved cell state. */
type GridItem = PickerItem

/** One column header — an interaction from the section's permission style (`{ id, name, code }`). */
interface GridColumn {
  readonly id: string
  readonly name: string
  readonly code: string
}

/** One rendered grid row — uniform across permission forms (5 cruds cells, or 2 v1 words). */
interface GridRow {
  /** The row's resource, serialized (`Observation`, `*`) — the stable row key. */
  readonly resource: string
  /** The 1:1 display label (or the wildcard label for `*`). */
  readonly label: string
  /** The live scope string for this row, shown in mono (detail-only, `spec.md §2`). */
  readonly code: string
  /** Interaction cells (`grid`) or an inline multiselect (`inline`, v1 words). */
  readonly layout: 'grid' | 'inline'
  /** The row's controls, in display order. */
  readonly items: readonly GridItem[]
}

/** Everything {@link PermissionGrid} renders: the section's interaction columns + its projected rows. */
interface Grid {
  /** The interaction columns, in canonical order (`spec.md §1`) — 5 for cruds, 2 for v1 words. */
  readonly columns: readonly GridColumn[]
  readonly rows: readonly GridRow[]
}

/**
 * One grid section — a single scope variant, its context, and the resources it lists
 * (`spec.md §1`). The `configuration` must be *one concrete variant*: narrow the
 * {@link Scope.ScopeConfiguration} union by `.id` (a `switch`) before building a
 * Section, so every read stays within that variant's homogeneous partition.
 */
interface Section<
  TContext extends Scope.Contexts.Context,
  TResource extends Scope.ResourceType.Base,
  TInteraction extends string,
  TId extends Scope.ResourceScope.Any['kind'],
> {
  readonly configuration: Scope.ScopeConfiguration<
    TContext,
    TResource,
    TInteraction,
    TId,
    Scope.ResourceScope.Base<TContext, TResource, TInteraction, TId>
  >
  /** The section's context — `new Fhir('patient')`, `new Wildflower()`, … */
  readonly context: TContext
  /** The resource names to list as rows (`spec.md §4`), e.g. `Scope.ResourceType.Fhir.catalog`. */
  readonly catalog: readonly string[]
}

/** Options for {@link buildGrid}. */
interface GridOptions {
  /** Prepend the live `*` wildcard row — open mode only (`spec.md §2/§3`). */
  readonly includeWildcard?: boolean
}

/**
 * Project a {@link Section} over the current draft into its {@link Grid}. Columns come off
 * the section's permission style; each catalog resource becomes a row (a name the variant
 * can't parse is skipped). In request mode each cell is clamped to `scopeRequest` (§2), and
 * in open mode a leading `*` wildcard row drives the union + lock of the rows beneath it (§3).
 */
const buildGrid = <
  TContext extends Scope.Contexts.Context,
  TResource extends Scope.ResourceType.Base,
  TInteraction extends string,
  TId extends Scope.ResourceScope.Any['kind'],
>(
  section: Section<TContext, TResource, TInteraction, TId>,
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  { includeWildcard = false }: GridOptions = {}
): Grid => {
  const { configuration, context, catalog } = section

  // The wildcard row's label ("✶ All record types") comes from the domain, so the lock
  // copy below doesn't duplicate it. Keyed by every {@link Cell.LockReason} kind, so the
  // map stays exhaustive — a new kind is a compile error until it's given copy.
  const wildcardLabel = configuration.resourceClass.parse('*')?.pluralLabel() ?? 'all record types'
  const lockCopy: Record<Cell.LockReason['kind'], string> = {
    wildcard: `Granted by the ${wildcardLabel} row — change it there`,
    required: 'Required by the app',
    notRequested: 'Not requested by the app',
  }

  /** Render `scopes-core`'s structured {@link Cell.LockReason} into the user-facing sentence. */
  const describeLock = (reason: Cell.LockReason | null): string | null =>
    reason === null ? null : lockCopy[reason.kind]

  /** The rendered row for one resource of this section. */
  const rowFor = (resource: TResource): GridRow => {
    const stored = configuration
      .select(grant)
      .find((scope) => scope.hasContext(context) && scope.hasResource(resource))
    return {
      resource: resource.serialize(),
      label: resource.singularLabel(),
      code: stored?.serialize() ?? `${context.serialize()}/${resource.serialize()}`,
      layout: configuration.permissionClass.empty.layout,
      items: configuration.permissionClass.empty.items.map((item) => {
        const cell = Cell.forItem(configuration, grant, scopeRequest, context, resource, item.id)
        return {
          id: item.id,
          name: item.name,
          code: item.code,
          state: cell.state,
          reason: describeLock(cell.lockReason),
        }
      }),
    }
  }

  const rows = catalog
    .map((name) => configuration.resourceClass.parse(name))
    .filter((resource): resource is TResource => resource !== null)
    .map(rowFor)

  const wildcard =
    includeWildcard && scopeRequest === null ? configuration.resourceClass.parse('*') : null
  return {
    columns: configuration.permissionClass.empty.items,
    rows: wildcard === null ? rows : [rowFor(wildcard), ...rows],
  }
}

export {
  type GridItem,
  type GridColumn,
  type GridRow,
  type Grid,
  type Section,
  type GridOptions,
  buildGrid,
}

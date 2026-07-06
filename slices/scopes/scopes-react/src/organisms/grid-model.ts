/**
 * The view-model for {@link PermissionGrid}: it projects one {@link Section} — a single
 * scope variant, its context, and the resource rows it lists — over the editable
 * {@link GrantDraft.GrantDraft} into a {@link Grid} (its columns + rows). The §2/§3
 * decisions and the row/wildcard policy live in `scopes-core` ({@link Rows.build});
 * this file is pure presentation — labels and lock copy — DOM-free and unit-tested on
 * its own.
 */

import { Rows } from 'scopes-core'
import type { Cell, GrantDraft, Scope, ScopeRequest } from 'scopes-core'

import type { PickerItem } from '../molecules/permission-picker.tsx'

/** One selectable control on a grid row — a permission item plus its resolved cell state. */
type GridItem<TInteractions extends string> = PickerItem<TInteractions>

/** One column header — an interaction from the section's permission style (`{ id, name, code }`). */
interface GridColumn<TInteractions extends string> {
  readonly id: TInteractions
  readonly name: string
  readonly code: string
}

/** One rendered grid row — uniform across permission forms (5 cruds cells, or 2 v1 words). */
interface GridRow<TResource extends Scope.ResourceType.Any, TInteractions extends string> {
  /** The row's typed resource (`Observation`, the `*` wildcard, …) — serialize it for the row key. */
  readonly resource: TResource
  /** The 1:1 display label (or the wildcard label for `*`). */
  readonly label: string
  /** The live scope string for this row, shown in mono (detail-only, `spec.md §2`). */
  readonly code: string
  /** Interaction cells (`grid`) or an inline multiselect (`inline`, v1 words). */
  readonly layout: 'grid' | 'inline'
  /** The row's controls, in display order. */
  readonly items: readonly GridItem<TInteractions>[]
}

/** Everything {@link PermissionGrid} renders: the section's interaction columns + its projected rows. */
interface Grid<TResource extends Scope.ResourceType.Any, TInteractions extends string> {
  /** The interaction columns, in canonical order (`spec.md §1`) — 5 for cruds, 2 for v1 words. */
  readonly columns: readonly GridColumn<TInteractions>[]
  readonly rows: readonly GridRow<TResource, TInteractions>[]
}

/**
 * One grid section — a single scope variant, its context, and the resources it lists
 * (`spec.md §1`). Generic over the single partition literal `K`: the `configuration` and
 * `context` are recovered from it by indexed access, so a Section is always *one concrete
 * variant* (narrow the {@link Scope.ScopeConfiguration} union by `.id` before building one)
 * and every read stays within that variant's homogeneous partition.
 */
interface Section<K extends Scope.MultiScope.Kind> {
  readonly configuration: Scope.MultiScope.ConfigurationFor<K>
  /** The section's context — `new Fhir('patient')`, `new Wildflower()`, … */
  readonly context: Scope.MultiScope.ContextOf<K>
  /** The resource names to list as rows (`spec.md §4`), e.g. `Scope.ResourceType.Fhir.catalog`. */
  readonly catalog: readonly string[]
}

/** Options for {@link buildGrid}. */
interface GridOptions {
  /**
   * Offer the live `*` wildcard row — always in open mode; in request mode only when
   * the app requested a wildcard at this context ({@link Rows.build}, `spec.md §2/§3`).
   */
  readonly includeWildcard?: boolean
}

/**
 * Project a {@link Section} over the current draft into its {@link Grid}. Columns come off
 * the section's permission style; each catalog resource becomes a row (a name the variant
 * can't parse is skipped). In request mode each cell is clamped to `scopeRequest` (§2), and
 * a leading `*` wildcard row — when {@link Rows.build}'s policy offers it — drives the
 * union + lock of the rows beneath it (§3).
 */
const buildGrid = <K extends Scope.MultiScope.Kind>(
  section: Section<K>,
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  { includeWildcard = false }: GridOptions = {}
): Grid<Scope.MultiScope.ResourceOf<K>, Scope.MultiScope.InteractionOf<K>> => {
  const { configuration, context, catalog } = section

  // The wildcard row's label ("✶ All record types") comes from the domain, so the lock
  // copy below doesn't duplicate it. Keyed by every {@link Cell.LockReason} kind, so the
  // map stays exhaustive — a new kind is a compile error until it's given copy.
  const wildcardLabel =
    configuration.resourceClass.wildcardResourceType?.pluralLabel() ?? 'all record types'
  const lockCopy: Record<Cell.LockReason['kind'], string> = {
    wildcard: `Granted by the ${wildcardLabel} row — change it there`,
    required: 'Required by the app',
    notRequested: 'Not requested by the app',
  }

  /** Render `scopes-core`'s structured {@link Cell.LockReason} into the user-facing sentence. */
  const describeLock = (reason: Cell.LockReason | null): string | null =>
    reason === null ? null : lockCopy[reason.kind]

  const rows = Rows.build(configuration, grant, scopeRequest, context, catalog, {
    includeWildcard,
  }).map(
    (row): GridRow<Scope.MultiScope.ResourceOf<K>, Scope.MultiScope.InteractionOf<K>> => ({
      resource: row.resource,
      label: row.resource.singularLabel(),
      code: row.stored?.serialize() ?? `${context.serialize()}/${row.resource.serialize()}`,
      layout: configuration.permissionClass.empty.layout,
      items: configuration.permissionClass.empty.items.map((item) => {
        const cell = row.cellFor(item.id)
        return {
          id: item.id,
          name: item.name,
          code: item.code,
          state: cell.state,
          reason: describeLock(cell.lockReason),
        }
      }),
    })
  )

  return {
    columns: configuration.permissionClass.empty.items,
    rows,
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

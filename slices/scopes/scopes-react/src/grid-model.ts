/**
 * View-model assembly for {@link PermissionGrid}. Turns a {@link GrantDraft.GrantDraft} (+ an
 * optional request scopeRequest) into renderable rows, so the grid component stays
 * presentational and the §2/§3 decisions live in `scopes-core`. Pure and
 * unit-tested independently of the DOM.
 */

import { AccessRights, ScopeContext, ScopeRequest, GrantDraft, Labels, Words } from 'scopes-core'

/** One Read/Write item on a v1 (word) row. */
export interface GridWordItem {
  readonly component: Words.Component
  readonly cell: ScopeRequest.Cell
}

/** One renderable grid row — either a 5-cell v2 row or a v1 Read/Write multiselect. */
export interface GridRow {
  readonly scopeContext: ScopeContext.ScopeContext
  readonly resource: string
  /** The 1:1 display label (or the wildcard label for `*`). */
  readonly label: string
  /** The live scope string for this row, shown in mono. */
  readonly code: string
  readonly form: 'word' | 'letters'
  /** v2 (`letters`) rows: one cell per CRUDS action, in canonical order. */
  readonly cells?: readonly ScopeRequest.Cell[]
  /** v1 (`word`) rows: the Read and Write components with their cell states. */
  readonly words?: readonly GridWordItem[]
}

const grantAccessFor = (
  grant: GrantDraft.GrantDraft,
  scopeContext: ScopeContext.ScopeContext,
  resource: string
): AccessRights.AccessRights | null =>
  GrantDraft.findResource(grant.scopes, scopeContext, resource)?.access ?? null

/** Parameters for {@link buildGridRows}. */
export interface BuildGridRowsParams {
  readonly grant: GrantDraft.GrantDraft
  readonly scopeRequest: ScopeRequest.ScopeRequest | null
  readonly scopeContext: ScopeContext.ScopeContext
  /** The resource types to render as rows (e.g. the catalog, or what was requested). */
  readonly resources: readonly string[]
  /** Prepend the live `*` wildcard row (open mode only — §2 hides it in request mode). */
  readonly includeWildcard?: boolean
}

const buildRow = (
  grant: GrantDraft.GrantDraft,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  scopeContext: ScopeContext.ScopeContext,
  resource: string
): GridRow => {
  const form = ScopeRequest.accessForm(grant, scopeRequest, scopeContext, resource)
  const requested =
    scopeRequest === null ? null : ScopeRequest.resourceFor(scopeRequest, scopeContext, resource)
  const currentAccess = grantAccessFor(grant, scopeContext, resource) ?? requested?.access ?? null
  const code =
    currentAccess === null
      ? `${ScopeContext.prefix(scopeContext)}/${resource}`
      : ScopeContext.code(scopeContext, resource, currentAccess)
  const label = Labels.resource(scopeContext, resource)

  if (form === 'word') {
    return {
      scopeContext,
      resource,
      label,
      code,
      form,
      words: Words.COMPONENTS.map((component) => ({
        component,
        cell: ScopeRequest.buildWordCell(grant, scopeRequest, scopeContext, resource, component),
      })),
    }
  }
  return {
    scopeContext,
    resource,
    label,
    code,
    form,
    cells: AccessRights.ACTION_ORDER.map((action) =>
      ScopeRequest.buildCell(grant, scopeRequest, scopeContext, resource, action)
    ),
  }
}

/**
 * Build the rows for one grid scope context. In request mode each resource is clamped
 * to the scopeRequest (§2); in open mode the `*` wildcard row can lead the list and
 * drives the union+lock of the rows below it (§3).
 */
export const buildGridRows = ({
  grant,
  scopeRequest,
  scopeContext,
  resources,
  includeWildcard = false,
}: BuildGridRowsParams): GridRow[] => {
  const rows = resources.map((resource) => buildRow(grant, scopeRequest, scopeContext, resource))
  if (includeWildcard && scopeRequest === null) {
    return [buildRow(grant, null, scopeContext, '*'), ...rows]
  }
  return rows
}

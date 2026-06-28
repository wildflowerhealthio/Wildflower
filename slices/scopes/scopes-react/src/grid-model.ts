/**
 * View-model assembly for {@link PermissionGrid}. Turns a {@link Grant} (+ an
 * optional request envelope) into renderable rows, so the grid component stays
 * presentational and the §2/§3 decisions live in `scopes-core`. Pure and
 * unit-tested independently of the DOM.
 */

import {
  ACTION_ORDER,
  buildCell,
  buildWordCell,
  bucketPrefix,
  envelopeResourceFor,
  findResource,
  resourceAccessForm,
  resourceLabel,
  scopeCode,
  WORD_COMPONENTS,
  type Access,
  type Bucket,
  type Cell,
  type Grant,
  type RequestEnvelope,
  type WordComponent,
} from 'scopes-core'

/** One Read/Write item on a v1 (word) row. */
export interface GridWordItem {
  readonly component: WordComponent
  readonly cell: Cell
}

/** One renderable grid row — either a 5-cell v2 row or a v1 Read/Write multiselect. */
export interface GridRow {
  readonly bucket: Bucket
  readonly resource: string
  /** The 1:1 display label (or the wildcard label for `*`). */
  readonly label: string
  /** The live scope string for this row, shown in mono. */
  readonly code: string
  readonly form: 'word' | 'letters'
  /** v2 (`letters`) rows: one cell per CRUDS action, in canonical order. */
  readonly cells?: readonly Cell[]
  /** v1 (`word`) rows: the Read and Write components with their cell states. */
  readonly words?: readonly GridWordItem[]
}

const grantAccessFor = (grant: Grant, bucket: Bucket, resource: string): Access | null =>
  findResource(grant.scopes, bucket, resource)?.access ?? null

/** Parameters for {@link buildGridRows}. */
export interface BuildGridRowsParams {
  readonly grant: Grant
  readonly envelope: RequestEnvelope | null
  readonly bucket: Bucket
  /** The resource types to render as rows (e.g. the catalog, or what was requested). */
  readonly resources: readonly string[]
  /** Prepend the live `*` wildcard row (open mode only — §2 hides it in request mode). */
  readonly includeWildcard?: boolean
}

const buildRow = (
  grant: Grant,
  envelope: RequestEnvelope | null,
  bucket: Bucket,
  resource: string
): GridRow => {
  const form = resourceAccessForm(grant, envelope, bucket, resource)
  const requested = envelope === null ? null : envelopeResourceFor(envelope, bucket, resource)
  const currentAccess = grantAccessFor(grant, bucket, resource) ?? requested?.access ?? null
  const code =
    currentAccess === null
      ? `${bucketPrefix(bucket)}/${resource}`
      : scopeCode(bucket, resource, currentAccess)
  const label = resourceLabel(bucket, resource)

  if (form === 'word') {
    return {
      bucket,
      resource,
      label,
      code,
      form,
      words: WORD_COMPONENTS.map((component) => ({
        component,
        cell: buildWordCell(grant, envelope, bucket, resource, component),
      })),
    }
  }
  return {
    bucket,
    resource,
    label,
    code,
    form,
    cells: ACTION_ORDER.map((action) => buildCell(grant, envelope, bucket, resource, action)),
  }
}

/**
 * Build the rows for one grid bucket. In request mode each resource is clamped
 * to the envelope (§2); in open mode the `*` wildcard row can lead the list and
 * drives the union+lock of the rows below it (§3).
 */
export const buildGridRows = ({
  grant,
  envelope,
  bucket,
  resources,
  includeWildcard = false,
}: BuildGridRowsParams): GridRow[] => {
  const rows = resources.map((resource) => buildRow(grant, envelope, bucket, resource))
  if (includeWildcard && envelope === null) {
    return [buildRow(grant, null, bucket, '*'), ...rows]
  }
  return rows
}

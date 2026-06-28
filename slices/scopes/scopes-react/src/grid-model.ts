/**
 * View-model assembly for {@link PermissionGrid}. Turns a {@link Grant.Any} (+ an
 * optional request envelope) into renderable rows, so the grid component stays
 * presentational and the §2/§3 decisions live in `scopes-core`. Pure and
 * unit-tested independently of the DOM.
 */

import { AccessRights, Bucket, Envelope, Grant, Labels, Words } from 'scopes-core'

/** One Read/Write item on a v1 (word) row. */
export interface GridWordItem {
  readonly component: Words.Component
  readonly cell: Envelope.Cell
}

/** One renderable grid row — either a 5-cell v2 row or a v1 Read/Write multiselect. */
export interface GridRow {
  readonly bucket: Bucket.Any
  readonly resource: string
  /** The 1:1 display label (or the wildcard label for `*`). */
  readonly label: string
  /** The live scope string for this row, shown in mono. */
  readonly code: string
  readonly form: 'word' | 'letters'
  /** v2 (`letters`) rows: one cell per CRUDS action, in canonical order. */
  readonly cells?: readonly Envelope.Cell[]
  /** v1 (`word`) rows: the Read and Write components with their cell states. */
  readonly words?: readonly GridWordItem[]
}

const grantAccessFor = (
  grant: Grant.Any,
  bucket: Bucket.Any,
  resource: string
): AccessRights.Any | null => Grant.findResource(grant.scopes, bucket, resource)?.access ?? null

/** Parameters for {@link buildGridRows}. */
export interface BuildGridRowsParams {
  readonly grant: Grant.Any
  readonly envelope: Envelope.Any | null
  readonly bucket: Bucket.Any
  /** The resource types to render as rows (e.g. the catalog, or what was requested). */
  readonly resources: readonly string[]
  /** Prepend the live `*` wildcard row (open mode only — §2 hides it in request mode). */
  readonly includeWildcard?: boolean
}

const buildRow = (
  grant: Grant.Any,
  envelope: Envelope.Any | null,
  bucket: Bucket.Any,
  resource: string
): GridRow => {
  const form = Envelope.accessForm(grant, envelope, bucket, resource)
  const requested = envelope === null ? null : Envelope.resourceFor(envelope, bucket, resource)
  const currentAccess = grantAccessFor(grant, bucket, resource) ?? requested?.access ?? null
  const code =
    currentAccess === null
      ? `${Bucket.prefix(bucket)}/${resource}`
      : Bucket.code(bucket, resource, currentAccess)
  const label = Labels.resource(bucket, resource)

  if (form === 'word') {
    return {
      bucket,
      resource,
      label,
      code,
      form,
      words: Words.COMPONENTS.map((component) => ({
        component,
        cell: Envelope.buildWordCell(grant, envelope, bucket, resource, component),
      })),
    }
  }
  return {
    bucket,
    resource,
    label,
    code,
    form,
    cells: AccessRights.ACTION_ORDER.map((action) =>
      Envelope.buildCell(grant, envelope, bucket, resource, action)
    ),
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

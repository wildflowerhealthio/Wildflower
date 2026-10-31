import * as PageHeader from '../document/page-header.ts'

/**
 * The laboratory block at the top right of every page — read off the page
 * header by label.
 *
 * @remarks
 * The fast-check `arbitrary` that lays a laboratory block out for tests lives
 * in the sibling `lab-arbitrary.ts` (test-only).
 *
 * @packageDocumentation
 */

/** The laboratory block at the top right of every page. */
interface Type {
  /** The `Address:` lines, one entry per printed line (`[]` when none). */
  readonly addressLines: readonly string[]
  /** The `Telephone:` value, or `''`. */
  readonly telephone: string
  /** The `Toll Free:` value, or `''`. */
  readonly tollFree: string
  /** The `Fax:` value, or `''`. */
  readonly fax: string
}

/**
 * Read the laboratory block off a page header. The `Address:` label's own line
 * is the first; the block's unlabelled lines below it are the rest.
 */
const fromPageHeader = (header: PageHeader.Type): Type => ({
  addressLines: [PageHeader.get(header, 'Address:'), ...header.addressLines].filter(
    (line) => line !== ''
  ),
  telephone: PageHeader.get(header, 'Telephone:'),
  tollFree: PageHeader.get(header, 'Toll Free:'),
  fax: PageHeader.get(header, 'Fax:'),
})

export { fromPageHeader }
export type { Type }

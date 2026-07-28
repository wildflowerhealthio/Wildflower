import type { DocumentReference } from 'fhir-r4/resources'

import { ANY } from '../exchanges/filter-exchanges.ts'

/**
 * The documents browser's filters, and their translation into the search
 * parameters the typed client sends.
 *
 * @remarks
 * Unlike the exchange filters, these narrow the *search* rather than an
 * already-loaded list: every axis here is a declared `DocumentReference` search
 * parameter, so the server does the narrowing and the browser never holds the
 * whole table. That is what 1A landed the parameters for.
 *
 * @packageDocumentation
 */

/** The FHIR R4 `DocumentReference.status` value set, as a filter option. */
type DocumentStatus = typeof DocumentReference.StatusSchema.Type

/**
 * Every status a document can carry, in the spec's order.
 *
 * @remarks
 * Spelled from the schema's own literals via {@link DocumentStatus} rather than
 * as free strings, so a status the client cannot express fails to typecheck
 * here instead of being rejected by the server.
 */
const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['current', 'superseded', 'entered-in-error']

/** What the documents browser is currently narrowed to. */
interface DocumentFilters {
  /**
   * A `category` token: a bare code, or the `system|code` form.
   *
   * @remarks
   * Free text rather than a select, because the browser is deliberately
   * category-agnostic — the device holds web traces, clinical documents, and
   * whatever a later collector writes, and a fixed list would hide the last of
   * those.
   */
  readonly category: string
  /** A `type` token, in the same two forms as {@link DocumentFilters.category}. */
  readonly type: string
  /** The document status to keep, or `all`. */
  readonly status: DocumentStatus | typeof ANY
}

/** Filters that narrow nothing — the browser's initial state. */
const NO_DOCUMENT_FILTERS: DocumentFilters = { category: '', type: '', status: ANY }

/** The search parameters {@link documentSearchParams} can produce. */
interface DocumentSearchParams {
  readonly category?: string
  readonly type?: string
  readonly status?: DocumentStatus
}

/**
 * The search parameters a filter set sends.
 *
 * @param filters - The active filters
 * @returns Only the parameters that actually narrow; a neutral control
 *   contributes no key at all
 *
 * @remarks
 * A neutral control must be **absent**, not empty. FHIR reads `category=` as a
 * search for the empty token, which matches nothing — so an untouched box would
 * silently produce "no documents on this device" rather than every document.
 * Token values are trimmed and passed through as written, since `system|code`
 * is the server's syntax and not this package's to reinterpret.
 */
const documentSearchParams = (filters: DocumentFilters): DocumentSearchParams => {
  const category = filters.category.trim()
  const type = filters.type.trim()
  return {
    ...(category === '' ? {} : { category }),
    ...(type === '' ? {} : { type }),
    ...(filters.status === ANY ? {} : { status: filters.status }),
  }
}

/** Whether any axis is narrowing, for the empty state to phrase itself honestly. */
const isNarrowed = (filters: DocumentFilters): boolean =>
  Object.keys(documentSearchParams(filters)).length > 0

export {
  DOCUMENT_STATUSES,
  type DocumentFilters,
  type DocumentSearchParams,
  type DocumentStatus,
  documentSearchParams,
  isNarrowed,
  NO_DOCUMENT_FILTERS,
}

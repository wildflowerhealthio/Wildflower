import type { CodeableConcept } from 'fhir-r4/data-types'
import type { StatusTone } from 'react-tundraish'

import type { FoundDocument } from '../queries/documents.ts'
import type { DocumentStatus } from './document-filters.ts'

/**
 * How a `DocumentReference` names itself in a list row and a detail heading.
 *
 * @remarks
 * Every helper here answers "what did the record actually say", never "what is
 * this probably". A `CodeableConcept` with no `text` and no `coding` produces
 * nothing rather than a placeholder, because a placeholder would read as a
 * value the server sent.
 *
 * @packageDocumentation
 */

/**
 * A FHIR system URI as the server stated it.
 *
 * @param system - The decoded `system`, or `null`
 * @returns The URI, or `null` when there is none
 *
 * @remarks
 * `Coding.system` and `Identifier.system` decode to `URL`, and `URL` **adds a
 * trailing slash to a host-only URI**: the server's `http://loinc.org` reads
 * back as `http://loinc.org/`. That matters here rather than being cosmetic,
 * because these strings are rendered as `system|code` tokens and a reader
 * copies one into the category or type box — where the extra slash would match
 * nothing. The lone root slash is dropped, and only that one: a URI with a path
 * keeps whatever trailing slash it actually carries, since the decode cannot
 * tell an added slash from a real one there.
 */
const systemUri = (system: URL | null): string | null => {
  if (system === null) return null
  const href = system.href
  return system.pathname === '/' && system.search === '' && system.hash === ''
    ? href.replace(/\/$/, '')
    : href
}

/**
 * A `CodeableConcept` as one readable string.
 *
 * @param concept - The concept to describe, or `null`
 * @returns `text` when the server supplied one, otherwise the codings joined,
 *   or `null` when the concept carries neither
 *
 * @remarks
 * `text` wins because FHIR defines it as the human-readable rendering the
 * source system intended; the codings are the fallback, spelled `system|code`
 * so a bare code is never mistaken for one from a different system.
 */
const describeConcept = (concept: typeof CodeableConcept.Schema.Type | null): string | null => {
  if (concept === null) return null
  if (concept.text !== null && concept.text !== '') return concept.text
  const codings = concept.coding
    .map((coding) => {
      const system = systemUri(coding.system)
      return system === null ? (coding.code ?? '') : `${system}|${coding.code ?? ''}`
    })
    .filter((coding) => coding !== '')
  return codings.length === 0 ? null : codings.join(', ')
}

/**
 * Every identifier on the document as one readable string.
 *
 * @param document - The document to describe
 * @returns The identifiers as `system|value` tokens, or `null` when it has none
 */
const describeIdentifiers = (document: FoundDocument): string | null => {
  const described = document.identifier
    .map((identifier) => {
      const system = systemUri(identifier.system)
      return system === null ? (identifier.value ?? '') : `${system}|${identifier.value ?? ''}`
    })
    .filter((identifier) => identifier !== '')
  return described.length === 0 ? null : described.join(', ')
}

/** Every category on the document as one readable string, or `null` when it has none. */
const describeCategories = (document: FoundDocument): string | null => {
  const described = document.category
    .map(describeConcept)
    .filter((category): category is string => category !== null)
  return described.length === 0 ? null : described.join(', ')
}

/**
 * The row title for a document.
 *
 * @param document - The document to name
 * @returns The first thing the record actually says: an attachment title, else
 *   its description, else its type, else its id
 *
 * @remarks
 * The id is the last resort rather than the first, because it names the row
 * uniquely but tells a reader nothing. It is never absent — a searchset
 * resource always carries one — so there is no case below it.
 */
const documentTitle = (document: FoundDocument): string => {
  const attachmentTitle = document.content
    .map((content) => content.attachment.title)
    .find((title): title is string => title !== null && title !== '')
  if (attachmentTitle !== undefined) return attachmentTitle
  if (document.description !== null && document.description !== '') return document.description
  return describeConcept(document.type) ?? document.id
}

/**
 * How a row summarises the document's content.
 *
 * @param document - The document to describe
 * @returns One entry per `content` element — its media type, and its size when
 *   the record states one
 *
 * @remarks
 * A `content` entry with no `contentType` reads as `unknown type`, matching how
 * the exchange list phrases a body the capture could not classify. An
 * attachment held by reference has no size to state and simply omits one; the
 * viewer is where that distinction is spelled out in full.
 */
const describeContent = (document: FoundDocument): string => {
  if (document.content.length === 0) return 'No content'
  return document.content
    .map((content) => {
      const contentType =
        content.attachment.contentType === null || content.attachment.contentType === ''
          ? 'unknown type'
          : content.attachment.contentType
      const size = content.attachment.size
      return size === null ? contentType : `${contentType} · ${size} bytes`
    })
    .join(' · ')
}

/**
 * The badge tone for a document status.
 *
 * @param status - The document's status
 * @returns The tone the list and the detail both badge it with
 *
 * @remarks
 * `entered-in-error` is toned as a danger because it is a retraction: the
 * record says this document should not have existed, and a reader who missed
 * that would quote something the source system has withdrawn. Lives here rather
 * than beside either surface so the two cannot tone the same status differently.
 */
const statusTone = (status: DocumentStatus): StatusTone => {
  if (status === 'current') return 'success'
  return status === 'superseded' ? 'info' : 'danger'
}

export {
  describeCategories,
  describeConcept,
  describeContent,
  describeIdentifiers,
  documentTitle,
  statusTone,
  systemUri,
}

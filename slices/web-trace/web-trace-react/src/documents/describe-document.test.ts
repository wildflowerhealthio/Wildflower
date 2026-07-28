import { Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import type { FoundDocument } from '../queries/documents.ts'
import {
  describeCategories,
  describeConcept,
  describeContent,
  describeIdentifiers,
  documentTitle,
  statusTone,
  systemUri,
} from './describe-document.ts'

/**
 * Documents are decoded through `DocumentReference.Schema` rather than
 * hand-written, so the fixtures carry the schema's absent-field handling
 * instead of a test author's guess at it — the same reason the `Attachment`
 * fixtures in `viewable-attachment.test.ts` decode wire JSON.
 */
const decode = Schema.decodeUnknownSync(DocumentReference.Schema)

const document = (wire: Record<string, unknown>): FoundDocument => {
  const decoded = decode({
    resourceType: 'DocumentReference',
    status: 'current',
    // `content` is required 1..* with no default, so a fixture that says
    // nothing about content still has to carry one.
    content: [{ attachment: {} }],
    ...wire,
  })
  return { ...decoded, id: typeof wire['id'] === 'string' ? wire['id'] : 'doc-0' }
}

const withContent = (attachment: Record<string, unknown>): Record<string, unknown> => ({
  content: [{ attachment }],
})

describe('describeConcept', () => {
  it('should prefer the text the source system supplied', () => {
    // Arrange
    const doc = document({ type: { text: 'Discharge summary', coding: [{ code: '18842-5' }] } })

    // Act / Assert
    expect(describeConcept(doc.type)).toBe('Discharge summary')
  })

  it('should fall back to codings spelled system|code, so a bare code cannot be mistaken', () => {
    // Arrange
    const doc = document({ type: { coding: [{ system: 'http://loinc.org', code: '18842-5' }] } })

    // Act / Assert
    expect(describeConcept(doc.type)).toBe('http://loinc.org|18842-5')
  })

  it('should describe nothing rather than a placeholder when the concept says nothing', () => {
    // Arrange — a placeholder here would read as a value the server sent
    const empty = document({ type: {} })

    // Act / Assert
    expect(describeConcept(empty.type)).toBeNull()
    expect(describeConcept(null)).toBeNull()
  })
})

describe('systemUri', () => {
  it('should not add the trailing slash URL gives a host-only URI', () => {
    // Arrange — the reader copies this token into the category box, and
    // `http://loinc.org/|18842-5` matches nothing on a server that stored
    // `http://loinc.org`.
    // Act / Assert
    expect(systemUri(new URL('http://loinc.org'))).toBe('http://loinc.org')
    expect(systemUri(new URL('http://loinc.org/'))).toBe('http://loinc.org')
  })

  it('should keep a trailing slash a URI with a path actually carries', () => {
    // Arrange / Act / Assert — the decode cannot tell an added slash from a
    // real one past the root, so nothing is stripped there.
    expect(systemUri(new URL('http://x.example.org/fhir/'))).toBe('http://x.example.org/fhir/')
    expect(systemUri(new URL('http://x.example.org/fhir'))).toBe('http://x.example.org/fhir')
    expect(systemUri(null)).toBeNull()
  })
})

describe('describeIdentifiers', () => {
  it('should spell each identifier system|value and say nothing when there are none', () => {
    // Arrange
    const doc = document({
      identifier: [{ system: 'http://example.org/mrn', value: '10432' }, { value: 'bare' }],
    })

    // Act / Assert
    expect(describeIdentifiers(doc)).toBe('http://example.org/mrn|10432, bare')
    expect(describeIdentifiers(document({}))).toBeNull()
  })
})

describe('describeCategories', () => {
  it('should join every category and say nothing when there are none', () => {
    // Arrange
    const both = document({
      category: [{ text: 'Web trace' }, { coding: [{ system: 'http://x', code: 'clinical' }] }],
    })

    // Act / Assert
    expect(describeCategories(both)).toBe('Web trace, http://x|clinical')
    expect(describeCategories(document({}))).toBeNull()
  })
})

describe('documentTitle', () => {
  it('should walk the fallback chain from attachment title down to the id', () => {
    // Arrange / Act / Assert — the id names the row uniquely but tells a reader
    // nothing, so it is the last resort rather than the first.
    expect(
      documentTitle(document({ id: 'doc-1', ...withContent({ title: 'Referral letter' }) }))
    ).toBe('Referral letter')
    expect(
      documentTitle(
        document({ id: 'doc-1', description: 'A referral', ...withContent({ title: '' }) })
      )
    ).toBe('A referral')
    expect(
      documentTitle(document({ id: 'doc-1', type: { text: 'Referral' }, ...withContent({}) }))
    ).toBe('Referral')
    expect(documentTitle(document({ id: 'doc-1', ...withContent({}) }))).toBe('doc-1')
  })

  it('should take a title from a later content entry when the first has none', () => {
    // Arrange
    const doc = document({
      id: 'doc-1',
      content: [{ attachment: {} }, { attachment: { title: 'Page two' } }],
    })

    // Act / Assert
    expect(documentTitle(doc)).toBe('Page two')
  })
})

describe('describeContent', () => {
  it('should name each entry with its media type and size', () => {
    // Arrange
    const doc = document({
      content: [
        { attachment: { contentType: 'application/pdf', size: 1024 } },
        { attachment: { contentType: 'application/json', size: 20 } },
      ],
    })

    // Act / Assert
    expect(describeContent(doc)).toBe('application/pdf · 1024 bytes · application/json · 20 bytes')
  })

  it('should say the type is unknown rather than blank, and omit a size the record never stated', () => {
    // Arrange — a by-reference attachment has no size to state
    const doc = document({ ...withContent({ url: 'https://files.example.org/x.pdf' }) })

    // Act / Assert
    expect(describeContent(doc)).toBe('unknown type')
  })

  it('should say a document reference with no content carries none', () => {
    // Arrange
    const doc = document({ content: [] })

    // Act / Assert
    expect(describeContent(doc)).toBe('No content')
  })
})

describe('statusTone', () => {
  it('should tone entered-in-error as a danger, since it is a retraction', () => {
    // Act / Assert — a reader who missed it would quote something the source
    // system has withdrawn.
    expect(statusTone('current')).toBe('success')
    expect(statusTone('superseded')).toBe('info')
    expect(statusTone('entered-in-error')).toBe('danger')
  })
})

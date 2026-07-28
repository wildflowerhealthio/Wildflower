import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { ANY } from '../exchanges/filter-exchanges.ts'
import {
  DOCUMENT_STATUSES,
  documentSearchParams,
  isNarrowed,
  NO_DOCUMENT_FILTERS,
  type DocumentFilters,
} from './document-filters.ts'

/**
 * Every value the status select can hold, typed as the union rather than left
 * to inference: spreading a `readonly DocumentStatus[]` straight into
 * `fc.constantFrom` widens the arbitrary to `string`, which no longer fits
 * {@link DocumentFilters}.
 */
const STATUS_CHOICES: readonly DocumentFilters['status'][] = [ANY, ...DOCUMENT_STATUSES]

describe('documentSearchParams', () => {
  it('should send no parameters at all when nothing is narrowed', () => {
    // Arrange / Act
    const params = documentSearchParams(NO_DOCUMENT_FILTERS)

    // Assert — a `category=` would be a search for the empty token, which
    // matches nothing, so an untouched form must send the key not at all.
    expect(params).toEqual({})
    expect(Object.hasOwn(params, 'category')).toBe(false)
    expect(Object.hasOwn(params, 'type')).toBe(false)
    expect(Object.hasOwn(params, 'status')).toBe(false)
  })

  it('should send each token as written, so system|code reaches the server intact', () => {
    // Arrange
    const filters: DocumentFilters = {
      category: 'http://wildflower.health/CodeSystem/web-trace|web-trace',
      type: 'http://loinc.org|34133-9',
      status: 'current',
    }

    // Act
    const params = documentSearchParams(filters)

    // Assert
    expect(params).toEqual({
      category: 'http://wildflower.health/CodeSystem/web-trace|web-trace',
      type: 'http://loinc.org|34133-9',
      status: 'current',
    })
  })

  it('should treat a whitespace-only token as untouched rather than as a search', () => {
    // Arrange — a box the reader typed into and cleared still holds spaces.
    const filters: DocumentFilters = { category: '   ', type: '\t', status: ANY }

    // Act / Assert
    expect(documentSearchParams(filters)).toEqual({})
  })

  it('should send every status the select can produce', () => {
    // Arrange / Act / Assert — the select is built from DOCUMENT_STATUSES, so
    // each of them has to survive the translation.
    for (const status of DOCUMENT_STATUSES) {
      expect(documentSearchParams({ ...NO_DOCUMENT_FILTERS, status })).toEqual({ status })
    }
  })

  it('should never emit an empty-string value for any axis', () => {
    // Arrange
    const whitespace = fc.stringMatching(/^[ \t\n]*$/)
    const token = fc.oneof(whitespace, fc.string())
    const status = fc.constantFrom(...STATUS_CHOICES)

    // Act / Assert — the property the empty-token trap rests on: whatever the
    // reader typed, a parameter that is present is a parameter that narrows.
    fc.assert(
      fc.property(token, token, status, (category, type, chosenStatus) => {
        const params = documentSearchParams({ category, type, status: chosenStatus })
        return Object.values(params).every((value) => value !== '')
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('isNarrowed', () => {
  it('should be false for the initial filters and true once any axis narrows', () => {
    // Arrange / Act / Assert
    expect(isNarrowed(NO_DOCUMENT_FILTERS)).toBe(false)
    expect(isNarrowed({ ...NO_DOCUMENT_FILTERS, category: 'web-trace' })).toBe(true)
    expect(isNarrowed({ ...NO_DOCUMENT_FILTERS, type: '34133-9' })).toBe(true)
    expect(isNarrowed({ ...NO_DOCUMENT_FILTERS, status: 'superseded' })).toBe(true)
  })

  it('should agree with documentSearchParams on every input', () => {
    // Arrange
    const filters = fc.record({
      category: fc.string(),
      type: fc.string(),
      status: fc.constantFrom(...STATUS_CHOICES),
    })

    // Act / Assert — the empty state's wording ("no documents on this device"
    // vs "none match this search") is only honest if the two cannot disagree.
    fc.assert(
      fc.property(filters, (one) => {
        const params = documentSearchParams(one)
        return isNarrowed(one) === Object.keys(params).length > 0
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

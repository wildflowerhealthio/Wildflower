import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { anonymizedJsonFileName } from './anonymized-json-file-name.ts'

describe('anonymizedJsonFileName', () => {
  it('should produce <stem>.anonymized.json from a .pdf file', () => {
    // Arrange & Act
    const result = anonymizedJsonFileName('lab-results.pdf')

    // Assert
    expect(result).toBe('lab-results.anonymized.json')
  })

  it('should strip .PDF case-insensitively', () => {
    // Arrange & Act & Assert
    expect(anonymizedJsonFileName('Report.PDF')).toBe('Report.anonymized.json')
    expect(anonymizedJsonFileName('scan.Pdf')).toBe('scan.anonymized.json')
  })

  it('should sanitise unsafe characters to hyphens', () => {
    // Arrange & Act
    const result = anonymizedJsonFileName('my file (1).pdf')

    // Assert
    expect(result).toBe('my-file-1.anonymized.json')
  })

  it('should fall back to "document" when the stem sanitises to nothing', () => {
    // Arrange & Act & Assert
    expect(anonymizedJsonFileName('.pdf')).toBe('document.anonymized.json')
    expect(anonymizedJsonFileName('!!!.pdf')).toBe('document.anonymized.json')
  })

  it('should handle a file with no extension', () => {
    // Arrange & Act
    const result = anonymizedJsonFileName('report')

    // Assert
    expect(result).toBe('report.anonymized.json')
  })

  it('should strip only the last .pdf extension', () => {
    // Arrange & Act
    const result = anonymizedJsonFileName('data.pdf.pdf')

    // Assert
    expect(result).toBe('data.pdf.anonymized.json')
  })

  it('should always end with .anonymized.json', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        // Act
        const result = anonymizedJsonFileName(name)

        // Assert
        expect(result).toMatch(/\.anonymized\.json$/)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never produce a hidden file on Unix', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        // Act
        const result = anonymizedJsonFileName(name)

        // Assert
        expect(result).not.toMatch(/^\./)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never contain filesystem-unsafe characters', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        // Act
        const result = anonymizedJsonFileName(name)

        // Assert — only alphanumeric, dot, hyphen, underscore
        expect(result).toMatch(/^[a-zA-Z0-9._-]+$/)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

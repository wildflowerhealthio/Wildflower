import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { PositionedTextDocument } from 'positioned-text'
import { extractFrequentSubstrings } from './frequent-substrings.ts'

describe('extractFrequentSubstrings', () => {
  it('should return an empty array for a document with no runs', () => {
    // Arrange
    const doc = emptyDoc()

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    expect(result).toEqual([])
  })

  it('should return an empty array when no word appears more than once', () => {
    // Arrange
    const doc = docWithRuns(['alpha beta gamma', 'delta epsilon zeta'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    expect(result).toEqual([])
  })

  it('should find a word that appears in multiple runs', () => {
    // Arrange
    const doc = docWithRuns(['Patient: John Smith', 'John Smith results', 'John is healthy'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const johnEntry = result.find((s) => s.text.toLowerCase() === 'john')
    expect(johnEntry).toBeDefined()
    expect(johnEntry!.count).toBe(3)
  })

  it('should find multi-word phrases that repeat', () => {
    // Arrange
    const doc = docWithRuns(['John Smith', 'Results for John Smith', 'John Smith labs'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const phrase = result.find((s) => s.text.toLowerCase() === 'john smith')
    expect(phrase).toBeDefined()
    expect(phrase!.count).toBe(3)
  })

  it('should count case-insensitively', () => {
    // Arrange
    const doc = docWithRuns(['John Smith', 'JOHN SMITH', 'john smith'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const phrase = result.find((s) => s.text.toLowerCase() === 'john smith')
    expect(phrase).toBeDefined()
    expect(phrase!.count).toBe(3)
  })

  it('should keep the casing of the first occurrence', () => {
    // Arrange
    const doc = docWithRuns(['Jane Doe', 'JANE DOE'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const phrase = result.find((s) => s.text.toLowerCase() === 'jane doe')
    expect(phrase).toBeDefined()
    expect(phrase!.text).toBe('Jane Doe')
  })

  it('should filter out short words (fewer than 3 characters)', () => {
    // Arrange
    const doc = docWithRuns(['an ox', 'an ox'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    expect(result.find((s) => s.text.toLowerCase() === 'an')).toBeUndefined()
  })

  it('should filter out stopwords for single-word entries', () => {
    // Arrange
    const doc = docWithRuns(['the patient', 'the doctor', 'the result'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    expect(result.find((s) => s.text.toLowerCase() === 'the')).toBeUndefined()
  })

  it('should sort by count descending, then by text length descending', () => {
    // Arrange
    const doc = docWithRuns(['Smith Labs', 'Smith Labs', 'Smith Labs', 'John Smith', 'John Smith'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const smithLabs = result.findIndex((s) => s.text.toLowerCase() === 'smith labs')
    const johnSmith = result.findIndex((s) => s.text.toLowerCase() === 'john smith')
    expect(smithLabs).toBeLessThan(johnSmith)
  })

  it('should cap results at 50', () => {
    // Arrange — create 55 distinct words each appearing twice
    const words = Array.from({ length: 55 }, (_, i) => `word${String(i).padStart(3, '0')}`)
    const doc = docWithRuns([words.join(' '), words.join(' ')])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    expect(result.length).toBeLessThanOrEqual(50)
  })

  it('should count words that appear multiple times within one run', () => {
    // Arrange
    const doc = docWithRuns(['Smith Smith Smith'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const smith = result.find((s) => s.text.toLowerCase() === 'smith')
    expect(smith).toBeDefined()
    expect(smith!.count).toBe(3)
  })

  it('should find trigrams that repeat', () => {
    // Arrange
    const doc = docWithRuns(['Dr Jane Doe', 'Dr Jane Doe'])

    // Act
    const result = extractFrequentSubstrings(doc)

    // Assert
    const trigram = result.find((s) => s.text.toLowerCase() === 'dr jane doe')
    expect(trigram).toBeDefined()
    expect(trigram!.count).toBe(2)
  })

  it('should always return results sorted by count descending', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 10 }),
        (texts) => {
          // Arrange
          const doc = docWithRuns(texts)

          // Act
          const result = extractFrequentSubstrings(doc)

          // Assert
          for (let i = 1; i < result.length; i += 1) {
            expect(result[i].count).toBeLessThanOrEqual(result[i - 1].count)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never return a result with count less than 2', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 10 }),
        (texts) => {
          // Arrange
          const doc = docWithRuns(texts)

          // Act
          const result = extractFrequentSubstrings(doc)

          // Assert
          for (const entry of result) {
            expect(entry.count).toBeGreaterThanOrEqual(2)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const emptyDoc = (): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  pages: [],
})

const docWithRuns = (texts: readonly string[]): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: texts.map((text, i) => ({ text, x: 72, y: 50 + i * 20, width: 200, fontSize: 12 })),
    },
  ],
})

import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { Document } from 'positioned-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { anonymizedJsonFileName, positionedTextBlob } from './download-json.ts'

const decode = Schema.decodeSync(Document.FromJson)

describe('positionedTextBlob', () => {
  it('should produce a blob that round-trips through Document.FromJson', async () => {
    // Arrange
    const doc: Document.Type = {
      format: 'wildflower-positioned-text',
      version: 1,
      fileName: 'report.pdf',
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [
            { text: 'Hello', x: 72, y: 50, width: 40, fontSize: 12, fontName: 'Arial' },
            { text: 'World', x: 72, y: 70, width: 40, fontSize: 12 },
          ],
        },
      ],
    }

    // Act
    const blob = positionedTextBlob(doc)
    const parsed = decode(await blob.text())

    // Assert
    expect(parsed).toEqual(doc)
  })
})

describe('downloadBlob', () => {
  let clicked: boolean

  beforeEach(() => {
    clicked = false
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (): string => 'blob:test/1',
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (): void => undefined,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      clicked = true
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
    vi.restoreAllMocks()
  })

  it('should trigger a download via anchor click', async () => {
    // Arrange
    const { downloadBlob } = await import('./download-json.ts')
    const blob = new Blob(['test'], { type: 'application/json' })

    // Act
    downloadBlob(blob, 'test.anonymized.json')

    // Assert
    expect(clicked).toBe(true)
  })
})

describe('anonymizedJsonFileName', () => {
  it('should produce <stem>.anonymized.json from a .pdf file', () => {
    // Arrange & Act & Assert
    expect(anonymizedJsonFileName('lab-results.pdf')).toBe('lab-results.anonymized.json')
  })

  it('should always end with .anonymized.json', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        // Act
        const result = anonymizedJsonFileName(name)

        // Assert
        expect(result).toMatch(/\.anonymized\.json$/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Document from './document.ts'
import * as Page from './page.ts'
import * as Run from './run.ts'

const encode = Schema.encodeSync(Document.FromJson)
const decode = Schema.decodeSync(Document.FromJson)

describe('Document.Schema', () => {
  it('should accept a minimal valid document', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      pages: [],
    }

    // Act
    const parsed = Schema.decodeUnknownSync(Document.Schema)(doc)

    // Assert
    expect(parsed.format).toBe('wildflower-positioned-text')
    expect(parsed.version).toBe(1)
    expect(parsed.pages).toEqual([])
  })

  it('should accept a document with runs and an optional fileName', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      fileName: 'report.pdf',
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [
            {
              text: 'LifeLabs',
              x: 72,
              y: 100,
              width: 60,
              fontSize: 14,
              fontName: 'Helvetica',
            },
          ],
        },
      ],
    }

    // Act
    const parsed = Schema.decodeUnknownSync(Document.Schema)(doc)

    // Assert
    expect(parsed.pages).toHaveLength(1)
    expect(parsed.pages[0].runs).toHaveLength(1)
    expect(parsed.pages[0].runs[0].fontName).toBe('Helvetica')
  })

  it('should accept runs without the optional fontName', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [{ text: 'hello', x: 0, y: 0, width: 30, fontSize: 12 }],
        },
      ],
    }

    // Act
    const parsed = Schema.decodeUnknownSync(Document.Schema)(doc)

    // Assert
    expect(parsed.pages[0].runs[0].fontName).toBeUndefined()
  })

  it('should reject a document with a wrong format tag', () => {
    // Arrange
    const doc = {
      format: 'wrong',
      version: 1,
      pages: [],
    }

    // Act & Assert
    expect(() => Schema.decodeUnknownSync(Document.Schema)(doc)).toThrow()
  })

  it('should reject a document with a wrong version', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text',
      version: 2,
      pages: [],
    }

    // Act & Assert
    expect(() => Schema.decodeUnknownSync(Document.Schema)(doc)).toThrow()
  })
})

describe('Document.FromJson', () => {
  it('should round-trip a document through JSON', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      fileName: 'lab-results.pdf',
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [
            { text: 'Patient Name', x: 72, y: 50, width: 80, fontSize: 12, fontName: 'Arial' },
            { text: 'Result: 5.4', x: 72, y: 100, width: 70, fontSize: 10 },
          ],
        },
      ],
    }

    // Act
    const json = encode(doc)
    const parsed = decode(json)

    // Assert
    expect(parsed).toEqual(doc)
  })

  it('should always round-trip through JSON for any valid document', () => {
    fc.assert(
      fc.property(positionedTextDocumentArb(), (doc) => {
        // Act
        const json = encode(doc)
        const parsed = decode(json)

        // Assert
        expect(parsed).toEqual(doc)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('mapText', () => {
  it('should apply the function to a run text while preserving geometry and font', () => {
    // Arrange
    const run = { text: 'hello', x: 10, y: 20, width: 30, fontSize: 12, fontName: 'Arial' }

    // Act
    const mapped = Run.mapText(run, (text) => text.toUpperCase())

    // Assert
    expect(mapped).toEqual({ ...run, text: 'HELLO' })
  })

  it('should map every run on a page and leave page geometry untouched', () => {
    // Arrange
    const page = {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: [
        { text: 'a', x: 0, y: 0, width: 5, fontSize: 10 },
        { text: 'b', x: 5, y: 0, width: 5, fontSize: 10 },
      ],
    }

    // Act
    const mapped = Page.mapText(page, (text) => `${text}!`)

    // Assert
    expect(mapped).toEqual({
      ...page,
      runs: [
        { ...page.runs[0], text: 'a!' },
        { ...page.runs[1], text: 'b!' },
      ],
    })
  })

  it('should map every run in the document across all pages', () => {
    // Arrange
    const doc = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      pages: [
        {
          pageNumber: 1,
          width: 1,
          height: 1,
          runs: [{ text: 'x', x: 0, y: 0, width: 1, fontSize: 1 }],
        },
        {
          pageNumber: 2,
          width: 1,
          height: 1,
          runs: [{ text: 'y', x: 0, y: 0, width: 1, fontSize: 1 }],
        },
      ],
    }

    // Act
    const mapped = Document.mapText(doc, (text) => text.toUpperCase())

    // Assert
    expect(mapped.pages.flatMap((page) => page.runs.map((run) => run.text))).toEqual(['X', 'Y'])
  })

  it('should leave every run text unchanged when mapped with identity', () => {
    fc.assert(
      fc.property(positionedTextDocumentArb(), (doc) => {
        // Act
        const mapped = Document.mapText(doc, (text) => text)

        // Assert
        expect(mapped).toEqual(doc)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should apply the function to every run text and preserve everything else', () => {
    fc.assert(
      fc.property(positionedTextDocumentArb(), (doc) => {
        // Act
        const mapped = Document.mapText(doc, (text) => `${text}Z`)

        // Assert
        mapped.pages.forEach((page, pageIndex) => {
          const original = doc.pages[pageIndex]
          expect({ ...page, runs: undefined }).toEqual({ ...original, runs: undefined })
          page.runs.forEach((run, runIndex) => {
            expect(run).toEqual({
              ...original.runs[runIndex],
              text: `${original.runs[runIndex].text}Z`,
            })
          })
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const positionedTextRunArb = (): fc.Arbitrary<{
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  fontName?: string
}> =>
  fc.record({
    text: fc.string(),
    x: fc.double({ min: 0, max: 1000, noNaN: true }),
    y: fc.double({ min: 0, max: 1000, noNaN: true }),
    width: fc.double({ min: 0, max: 1000, noNaN: true }),
    fontSize: fc.double({ min: 1, max: 100, noNaN: true }),
    fontName: fc.option(fc.string(), { nil: undefined }),
  })

const positionedTextPageArb = (): fc.Arbitrary<{
  pageNumber: number
  width: number
  height: number
  runs: Array<{
    text: string
    x: number
    y: number
    width: number
    fontSize: number
    fontName?: string
  }>
}> =>
  fc.record({
    pageNumber: fc.nat({ max: 999 }),
    width: fc.double({ min: 1, max: 2000, noNaN: true }),
    height: fc.double({ min: 1, max: 2000, noNaN: true }),
    runs: fc.array(positionedTextRunArb()),
  })

const positionedTextDocumentArb = (): fc.Arbitrary<{
  format: 'wildflower-positioned-text'
  version: 1
  fileName?: string
  pages: Array<{
    pageNumber: number
    width: number
    height: number
    runs: Array<{
      text: string
      x: number
      y: number
      width: number
      fontSize: number
      fontName?: string
    }>
  }>
}> =>
  fc.record({
    format: fc.constant('wildflower-positioned-text' as const),
    version: fc.constant(1 as const),
    fileName: fc.option(fc.string(), { nil: undefined }),
    pages: fc.array(positionedTextPageArb()),
  })

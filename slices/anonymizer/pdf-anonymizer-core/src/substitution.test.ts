import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { PositionedTextDocument } from './positioned-text.ts'
import { applySubstitutions, maskSameLength } from './substitution.ts'

describe('maskSameLength', () => {
  it('should replace uppercase letters with X', () => {
    // Arrange & Act
    const result = maskSameLength('ABC')

    // Assert
    expect(result).toBe('XXX')
  })

  it('should replace lowercase letters with x', () => {
    // Arrange & Act
    const result = maskSameLength('abc')

    // Assert
    expect(result).toBe('xxx')
  })

  it('should replace digits with 0', () => {
    // Arrange & Act
    const result = maskSameLength('123')

    // Assert
    expect(result).toBe('000')
  })

  it('should keep punctuation and whitespace verbatim', () => {
    // Arrange & Act
    const result = maskSameLength('A-b.1 C')

    // Assert
    expect(result).toBe('X-x.0 X')
  })

  it('should mask a realistic health card number', () => {
    // Arrange & Act
    const result = maskSameLength('1234-567-890-AB')

    // Assert
    expect(result).toBe('0000-000-000-XX')
  })

  it('should always preserve the length of the input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        // Act
        const result = maskSameLength(input)

        // Assert
        expect(result).toHaveLength(input.length)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always be idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        // Act
        const once = maskSameLength(input)
        const twice = maskSameLength(once)

        // Assert
        expect(twice).toBe(once)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should return an empty string for empty input', () => {
    // Arrange & Act & Assert
    expect(maskSameLength('')).toBe('')
  })
})

describe('applySubstitutions', () => {
  it('should replace a case-insensitive literal match within a run', () => {
    // Arrange
    const doc = docWith('John Smith had a test')
    const rules = [{ id: 'r1', text: 'John Smith' }]

    // Act
    const { document, ruleMatches } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('Xxxx Xxxxx had a test')
    expect(ruleMatches).toEqual([{ ruleId: 'r1', count: 1 }])
  })

  it('should match case-insensitively', () => {
    // Arrange
    const doc = docWith('JOHN smith')
    const rules = [{ id: 'r1', text: 'john SMITH' }]

    // Act
    const { document } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('XXXX xxxxx')
  })

  it('should replace all occurrences globally', () => {
    // Arrange
    const doc = docWith('AB CD AB EF AB')
    const rules = [{ id: 'r1', text: 'AB' }]

    // Act
    const { document, ruleMatches } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('XX CD XX EF XX')
    expect(ruleMatches).toEqual([{ ruleId: 'r1', count: 3 }])
  })

  it('should apply rules in order over the previous result', () => {
    // Arrange
    const doc = docWith('Jane Doe, ID: 12345')
    const rules = [
      { id: 'r1', text: 'Jane Doe' },
      { id: 'r2', text: '12345' },
    ]

    // Act
    const { document, ruleMatches } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('Xxxx Xxx, ID: 00000')
    expect(ruleMatches).toEqual([
      { ruleId: 'r1', count: 1 },
      { ruleId: 'r2', count: 1 },
    ])
  })

  it('should report zero matches for rules that do not appear', () => {
    // Arrange
    const doc = docWith('nothing here')
    const rules = [{ id: 'r1', text: 'missing' }]

    // Act
    const { document, ruleMatches } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('nothing here')
    expect(ruleMatches).toEqual([{ ruleId: 'r1', count: 0 }])
  })

  it('should skip empty-text rules without error', () => {
    // Arrange
    const doc = docWith('hello')
    const rules = [{ id: 'r1', text: '' }]

    // Act
    const { document, ruleMatches } = applySubstitutions(doc, rules)

    // Assert
    expect(textOf(document)).toBe('hello')
    expect(ruleMatches).toEqual([{ ruleId: 'r1', count: 0 }])
  })

  it('should match within each run independently', () => {
    // Arrange — the name spans two separate runs
    const doc = multiRunDoc(['John', ' Smith'])
    const rules = [{ id: 'r1', text: 'John Smith' }]

    // Act
    const { ruleMatches } = applySubstitutions(doc, rules)

    // Assert — no cross-run match
    expect(ruleMatches).toEqual([{ ruleId: 'r1', count: 0 }])
  })

  it('should leave non-matching runs byte-identical', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (runText, ruleText) => {
        fc.pre(!runText.toLowerCase().includes(ruleText.toLowerCase()))

        // Arrange
        const doc = docWith(runText)
        const rules = [{ id: 'r1', text: ruleText }]

        // Act
        const { document } = applySubstitutions(doc, rules)

        // Assert
        expect(textOf(document)).toBe(runText)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never leave the rule text in the output', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (prefix, ruleText) => {
        fc.pre(/[a-wyzA-WYZ1-9]/.test(ruleText))

        // Arrange
        const doc = docWith(prefix + ruleText)
        const rules = [{ id: 'r1', text: ruleText }]

        // Act
        const { document } = applySubstitutions(doc, rules)

        // Assert
        expect(textOf(document).toLowerCase()).not.toContain(ruleText.toLowerCase())
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always preserve the length of each run', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (runText, ruleText) => {
        // Arrange
        const doc = docWith(runText)
        const rules = [{ id: 'r1', text: ruleText }]

        // Act
        const { document } = applySubstitutions(doc, rules)

        // Assert
        expect(textOf(document)).toHaveLength(runText.length)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should always produce an idempotent result', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (runText, ruleText) => {
        // Arrange
        const doc = docWith(runText)
        const rules = [{ id: 'r1', text: ruleText }]

        // Act
        const once = applySubstitutions(doc, rules)
        const twice = applySubstitutions(once.document, rules)

        // Assert
        expect(textOf(twice.document)).toBe(textOf(once.document))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

// Helpers

const docWith = (text: string): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: [{ text, x: 0, y: 0, width: 100, fontSize: 12 }],
    },
  ],
})

const multiRunDoc = (texts: readonly string[]): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: texts.map((text, i) => ({ text, x: i * 50, y: 0, width: 50, fontSize: 12 })),
    },
  ],
})

const textOf = (doc: PositionedTextDocument): string =>
  doc.pages.flatMap((p) => p.runs.map((r) => r.text)).join('')

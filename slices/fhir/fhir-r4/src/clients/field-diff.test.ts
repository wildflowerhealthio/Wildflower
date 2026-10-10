import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { ABSENT, diffJson, formatPath, formatSlot, present, setAtPath } from './field-diff.ts'

/**
 * The pure leaf-level diff engine behind a `changed` server comparison:
 * `diffJson` enumerates the differing leaves (server → incoming), `formatPath`
 * renders a leaf path, `formatSlot` renders one side, and `setAtPath`
 * immutably resets one leaf — the machinery the "keep server value" control
 * is built on.
 */
describe('diffJson', () => {
  it('should find no differences between a value and itself', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        // Act + Assert: same value on both sides is always empty.
        expect(diffJson(value, value)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should report a single changed leaf as one server → incoming diff', () => {
    // Arrange
    const server = { resourceType: 'Patient', gender: 'male' }
    const incoming = { resourceType: 'Patient', gender: 'female' }

    // Act
    const diffs = diffJson(server, incoming)

    // Assert
    expect(diffs).toEqual([
      { path: ['gender'], server: present('male'), incoming: present('female') },
    ])
  })

  it('should descend into nested objects and arrays to reach the differing leaf', () => {
    // Arrange
    const server = { name: [{ family: 'Smith', given: ['Ada'] }] }
    const incoming = { name: [{ family: 'Smyth', given: ['Ada'] }] }

    // Act
    const diffs = diffJson(server, incoming)

    // Assert
    expect(diffs).toEqual([
      { path: ['name', 0, 'family'], server: present('Smith'), incoming: present('Smyth') },
    ])
  })

  it('should report a field present on one side only as an absent slot', () => {
    // Arrange
    const server = { resourceType: 'Patient' }
    const incoming = { resourceType: 'Patient', gender: 'other' }

    // Act
    const diffs = diffJson(server, incoming)

    // Assert
    expect(diffs).toEqual([{ path: ['gender'], server: ABSENT, incoming: present('other') }])
  })

  it('should report an added array element as an absent server slot at its index', () => {
    // Arrange
    const server = { given: ['Ada'] }
    const incoming = { given: ['Ada', 'Grace'] }

    // Act
    const diffs = diffJson(server, incoming)

    // Assert
    expect(diffs).toEqual([{ path: ['given', 1], server: ABSENT, incoming: present('Grace') }])
  })
})

describe('formatPath', () => {
  it('should render object keys dotted and array indices bracketed', () => {
    expect(formatPath(['name', 0, 'family'])).toBe('name[0].family')
    expect(formatPath(['gender'])).toBe('gender')
    expect(formatPath(['meta', 'profile', 1])).toBe('meta.profile[1]')
  })
})

describe('formatSlot', () => {
  it('should render a present value as a JSON literal', () => {
    expect(formatSlot(present('male'))).toBe('"male"')
    expect(formatSlot(present(42))).toBe('42')
  })

  it('should render an absent slot as (absent)', () => {
    expect(formatSlot(ABSENT)).toBe('(absent)')
  })
})

describe('setAtPath', () => {
  it('should set an object key without mutating the input', () => {
    fc.assert(
      fc.property(scalarRecord(), fc.string(), fc.jsonValue(), (object, key, value) => {
        // Arrange
        const before = JSON.stringify(object)

        // Act
        const result = setAtPath(object, [key], present(value))

        // Assert: the input is untouched, the result carries the new value.
        expect(JSON.stringify(object)).toBe(before)
        expect(result).toEqual({ ...object, [key]: value })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should remove an object key for an absent slot', () => {
    fc.assert(
      fc.property(scalarRecord(), fc.string(), fc.jsonValue(), (object, key, value) => {
        // Arrange: the expected result is the record without that key.
        const expected = { ...object }
        delete expected[key]

        // Act
        const result = setAtPath({ ...object, [key]: value }, [key], ABSENT)

        // Assert
        expect(result).toEqual(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reset each differing leaf so it no longer diffs against the server', () => {
    fc.assert(
      fc.property(scalarRecord(), scalarRecord(), (server, incoming) => {
        // Act + Assert: resetting one leaf (independently) closes that one gap.
        for (const field of diffJson(server, incoming)) {
          const patched = setAtPath(incoming, field.path, field.server)
          const remaining = diffJson(server, patched).map((diff) => formatPath(diff.path))
          expect(remaining).not.toContain(formatPath(field.path))
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A flat record of scalar values — no nested containers to reshuffle on a splice. */
const scalarRecord = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)))

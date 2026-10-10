import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

// side-effect: the data-types barrel runs every complex datatype's
// `registerDatatypeSchema(...)`, so the registered slots below resolve.
import '../index.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from './choice-element-passthrough-fields.ts'

describe('filterForExclusiveChoiceElementSet', () => {
  it('should decode a payload with exactly one populated slot', () => {
    // Arrange
    const wire = { valueString: 'Negative for influenza A' }

    // Act
    const decoded = Schema.decodeUnknownSync(Reading)(wire)

    // Assert
    expect(decoded).toEqual({
      valueString: 'Negative for influenza A',
      valueInteger: null,
      valueBoolean: null,
      effectiveDateTime: null,
      effectivePeriod: null,
    })
  })

  it('should decode a payload with no populated slot', () => {
    // Arrange
    const wire = {}

    // Act
    const decoded = Schema.decodeUnknownEither(Reading)(wire)

    // Assert
    expect(Either.isRight(decoded)).toBe(true)
  })

  it('should reject decoding two populated slots, naming both', () => {
    // Arrange
    const wire = { valueString: 'hi', valueInteger: 5 }

    // Act
    const message = decodeFailureMessage(wire)

    // Assert
    expect(message).toContain(
      'choice element value[x] allows at most one populated slot, but found 2: valueString, valueInteger'
    )
  })

  it('should reject encoding a value with two populated slots, naming both', () => {
    // Arrange
    const reading: typeof Reading.Type = {
      valueString: null,
      valueInteger: 120,
      valueBoolean: true,
      effectiveDateTime: null,
      effectivePeriod: null,
    }

    // Act
    const message = encodeFailureMessage(reading)

    // Assert
    expect(message).toContain(
      'choice element value[x] allows at most one populated slot, but found 2: valueInteger, valueBoolean'
    )
  })

  it('should count each choice element separately', () => {
    // Arrange
    const wire = { valueInteger: 72, effectiveDateTime: '2024-03-01T09:30:00Z' }

    // Act
    const decoded = Schema.decodeUnknownEither(Reading)(wire)

    // Assert
    expect(Either.isRight(decoded)).toBe(true)
  })

  it('should reject encoding a non-null value in an unregistered slot', () => {
    // Arrange
    const Priced = Schema.Struct(choiceElementSetPassthroughFields('value', ['Money'])).pipe(
      filterForExclusiveChoiceElementSet('value', ['Money'])
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the unregistered slot's decoded type is `null`; a non-null value is constructed on purpose to exercise the encode failure
    const priced = { valueMoney: { value: 12.5, currency: 'CAD' } } as unknown as typeof Priced.Type

    // Act
    const encoded = Schema.encodeEither(Priced)(priced)

    // Assert
    expect(Either.isLeft(encoded)).toBe(true)
  })

  it('should decode any payload populating at most one slot', () => {
    fc.assert(
      fc.property(
        valueSlotsArb.chain((slots) => fc.subarray(slots, { maxLength: 1 })),
        (populated) => {
          // Arrange
          const wire = Object.fromEntries(populated)

          // Act
          const decoded = Schema.decodeUnknownEither(Reading)(wire)

          // Assert
          expect(Either.isRight(decoded)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject decoding any payload populating two or more slots', () => {
    fc.assert(
      fc.property(
        valueSlotsArb.chain((slots) => fc.subarray(slots, { minLength: 2 })),
        (populated) => {
          // Arrange
          const wire = Object.fromEntries(populated)

          // Act
          const message = decodeFailureMessage(wire)

          // Assert
          expect(message).toContain(`but found ${populated.length}:`)
          for (const [key] of populated) expect(message).toContain(key)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

// A two-choice-element struct: `value[x]` over three primitives and
// `effective[x]` over two datatypes, each guarded.
const valueNames = ['string', 'integer', 'boolean'] as const
const effectiveNames = ['dateTime', 'Period'] as const
const Reading = Schema.Struct({
  ...choiceElementSetPassthroughFields('value', valueNames),
  ...choiceElementSetPassthroughFields('effective', effectiveNames),
}).pipe(
  filterForExclusiveChoiceElementSet('value', valueNames),
  filterForExclusiveChoiceElementSet('effective', effectiveNames)
)

// Every `value[x]` slot of `Reading`, each paired with a wire value.
const valueSlotsArb: fc.Arbitrary<(readonly [string, unknown])[]> = fc.tuple(
  fc.string().map((v) => ['valueString', v] as const),
  fc.integer().map((v) => ['valueInteger', v] as const),
  fc.boolean().map((v) => ['valueBoolean', v] as const)
)

const decodeFailureMessage = (wire: unknown): string =>
  Either.match(Schema.decodeUnknownEither(Reading)(wire), {
    onLeft: (error) => error.message,
    onRight: () => 'decoded without error',
  })

const encodeFailureMessage = (reading: typeof Reading.Type): string =>
  Either.match(Schema.encodeEither(Reading)(reading), {
    onLeft: (error) => error.message,
    onRight: () => 'encoded without error',
  })

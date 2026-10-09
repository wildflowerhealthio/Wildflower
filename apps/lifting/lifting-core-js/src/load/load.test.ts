import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, Quantity } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { amountArb, issuePathsOf, loadUnitArb, made, throughWire } from '../test-helpers.ts'
import * as Load from './load.ts'

const RUNS = numRunsFor({ base: 100 })

/** A load as the wire carries it: a `Quantity`, decoded and then narrowed. */
const WireLoad = Schema.compose(Quantity.Schema, Load.Schema)

describe('Load', () => {
  it('should write a pound load as UCUM [lb_av] and a kilogram load as kg, each with a display unit', () => {
    expect(
      Schema.encodeSync(WireLoad)(made(Load.make({ value: 135, unit: '[lb_av]' })))
    ).toMatchObject({
      value: 135,
      unit: 'lb',
      system: 'http://unitsofmeasure.org',
      code: '[lb_av]',
    })
    expect(Schema.encodeSync(WireLoad)(made(Load.make({ value: 60, unit: 'kg' })))).toMatchObject({
      value: 60,
      unit: 'kg',
      system: 'http://unitsofmeasure.org',
      code: 'kg',
    })
  })

  it('should read back the value and unit of every load it makes, through the wire', () => {
    fc.assert(
      fc.property(amountArb, loadUnitArb, (value, unit) => {
        const load = throughWire(WireLoad, made(Load.make({ value, unit })))
        expect([Load.valueOf(load), Load.unitOf(load)]).toEqual([value, unit])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a value that is not finite and non-negative', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(-1, Number.NaN, Number.POSITIVE_INFINITY),
        loadUnitArb,
        (value, unit) => {
          expect(issuePathsOf(Load.make({ value, unit }))).toEqual(['value'])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a quantity with a comparator, another code or another system, naming the field', () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.constantFrom('comparator' as const, 'code' as const, 'system' as const),
        (value, field) => {
          // Arrange
          const load = made(Load.make({ value, unit: '[lb_av]' }))
          const quantity: Quantity.Type = {
            comparator: { ...load, comparator: '<' as const },
            code: { ...load, code: Code.make('st') },
            system: { ...load, system: 'http://example.org/units' },
          }[field]

          // Act / Assert
          expect(issuePathsOf(Schema.decodeEither(Load.Schema)(quantity))).toEqual([field])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should keep the unit when it moves the value', () => {
    fc.assert(
      fc.property(amountArb, amountArb, loadUnitArb, (value, next, unit) => {
        const moved = Load.withValue(made(Load.make({ value, unit })), next)
        expect(Either.map(moved, (load) => [Load.valueOf(load), Load.unitOf(load)])).toEqual(
          Either.right([next, unit])
        )
      }),
      { numRuns: RUNS }
    )
  })
})

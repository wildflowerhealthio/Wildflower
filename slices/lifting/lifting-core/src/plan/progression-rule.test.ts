import { Either, Record, Schema } from 'effect'
import * as fc from 'fast-check'
import { Extension, WildflowerExtension } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Load from '../load/load.ts'
import {
  issuePathsOf,
  made,
  progressionRuleArb,
  progressionRuleInputArb,
  throughWire,
} from '../test-helpers.ts'
import * as ProgressionRule from './progression-rule.ts'

const RUNS = numRunsFor({ base: 100 })

/** A rule as the wire carries it: an `Extension`, decoded and then narrowed. */
const WireProgressionRule = Schema.compose(Extension.Schema, ProgressionRule.Schema)

type RuleInput = Parameters<typeof ProgressionRule.make>[0]

/** One in-type but out-of-range value per parameter, and the index of the part it lands in. */
const breakPart: {
  readonly [Part in Exclude<keyof RuleInput, 'unit'>]: readonly [number, number]
} = {
  increment: [1, 0],
  failuresBeforeDeload: [2, 0],
  deloadFraction: [3, 1],
  minimumLoad: [4, -1],
  loadStep: [5, 0],
}
const PARAMETERS = Record.keys(breakPart)

describe('ProgressionRule', () => {
  it('should read back every parameter of every rule it makes, through the wire', () => {
    fc.assert(
      fc.property(progressionRuleInputArb, (input) => {
        const rule = throughWire(WireProgressionRule, made(ProgressionRule.make(input)))
        expect({
          unit: ProgressionRule.unitOf(rule),
          increment: ProgressionRule.incrementOf(rule),
          failuresBeforeDeload: ProgressionRule.failuresBeforeDeloadOf(rule),
          deloadFraction: ProgressionRule.deloadFractionOf(rule),
          minimumLoad: ProgressionRule.minimumLoadOf(rule),
          loadStep: ProgressionRule.loadStepOf(rule),
        }).toEqual(input)
      }),
      { numRuns: RUNS }
    )
  })

  it('should write each parameter as a sub-extension of a LiftingProgression extension', () => {
    const wire = Schema.encodeSync(WireProgressionRule)(
      made(
        ProgressionRule.make({
          unit: '[lb_av]',
          increment: 5,
          failuresBeforeDeload: 3,
          deloadFraction: 0.1,
          minimumLoad: 45,
          loadStep: 5,
        })
      )
    )
    expect(wire).toMatchObject({
      url: WildflowerExtension.LiftingProgression,
      extension: [
        { url: 'unit', valueString: '[lb_av]' },
        { url: 'increment', valueDecimal: 5 },
        { url: 'failuresBeforeDeload', valueInteger: 3 },
        { url: 'deloadFraction', valueDecimal: 0.1 },
        { url: 'minimumLoad', valueDecimal: 45 },
        { url: 'loadStep', valueDecimal: 5 },
      ],
    })
  })

  it('should name exactly the parameter pushed out of range, and every one at once', () => {
    fc.assert(
      fc.property(
        progressionRuleInputArb,
        fc.subarray([...PARAMETERS], { minLength: 1 }),
        (input, broken) => {
          // Arrange
          const edited = {
            ...input,
            ...Record.fromEntries(broken.map((p) => [p, breakPart[p][1]])),
          }

          // Act / Assert
          expect(issuePathsOf(ProgressionRule.make(edited))).toEqual(
            broken
              .map((parameter) => breakPart[parameter][0])
              .toSorted((a, b) => a - b)
              .map((index) => `extension.${index}.value${index === 2 ? 'Integer' : 'Decimal'}`)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a missing or repeated part, and another extension url', () => {
    fc.assert(
      fc.property(progressionRuleArb, fc.nat({ max: 5 }), (rule, index) => {
        const decode = Schema.decodeEither(ProgressionRule.Schema)
        expect(
          issuePathsOf(
            decode({ ...rule, extension: rule.extension.filter((_, at) => at !== index) })
          )
        ).toEqual(['extension'])
        expect(
          issuePathsOf(
            decode({
              ...rule,
              extension: [...rule.extension, ...rule.extension.slice(index, index + 1)],
            })
          )
        ).toEqual(['extension'])
        expect(
          issuePathsOf(decode({ ...rule, url: WildflowerExtension.LiftingMeasureValue }))
        ).toEqual(['url'])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('movableLoadSchema / startingLoadSchema', () => {
  it("should accept a load in the rule's unit, and refuse one in the other", () => {
    fc.assert(
      fc.property(progressionRuleArb, (rule) => {
        const unit = ProgressionRule.unitOf(rule)
        const other = unit === '[lb_av]' ? 'kg' : '[lb_av]'
        const at = ProgressionRule.minimumLoadOf(rule) + 1
        const validate = Schema.validateEither(ProgressionRule.movableLoadSchema(rule))
        expect(Either.isRight(validate(made(Load.make({ value: at, unit }))))).toBe(true)
        expect(Either.isLeft(validate(made(Load.make({ value: at, unit: other }))))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  it("should refuse a starting load under the floor in the rule's unit, and only the unit in the other", () => {
    fc.assert(
      fc.property(progressionRuleArb, fc.boolean(), (rule, wrongUnit) => {
        // Arrange
        fc.pre(ProgressionRule.minimumLoadOf(rule) > 0)
        const unit = ProgressionRule.unitOf(rule)
        const otherUnit = unit === '[lb_av]' ? 'kg' : '[lb_av]'
        const load = made(
          Load.make({
            value: ProgressionRule.minimumLoadOf(rule) / 2,
            unit: wrongUnit ? otherUnit : unit,
          })
        )

        // Act
        const messages = Either.match(
          Schema.validateEither(ProgressionRule.startingLoadSchema(rule), { errors: 'all' })(load),
          { onLeft: (error) => error.message, onRight: () => '' }
        )

        // Assert: a floor in another unit says nothing about the load given.
        expect(messages).toContain(
          wrongUnit ? `expected a load in ${unit}` : 'expected a load of at least'
        )
        expect(messages).not.toContain(
          wrongUnit ? 'expected a load of at least' : 'expected a load in'
        )
      }),
      { numRuns: RUNS }
    )
  })
})

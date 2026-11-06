import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { HealthCardIdentifier, type HealthCardProvince } from './index.ts'

const digits = fc.stringMatching(/^\d{10}$/)
const versionCode = fc.stringMatching(/^[A-Za-z]{1,2}$/)
const separators = fc.stringMatching(/^[ -]{0,3}$/)

/** `characters` printed with a run of spaces and hyphens before, between and after each. */
const printedWithSeparators = (characters: string): fc.Arbitrary<string> =>
  fc
    .array(separators, { minLength: characters.length + 1, maxLength: characters.length + 1 })
    .map((between) =>
      between.map((separator, index) => `${separator}${characters[index] ?? ''}`).join('')
    )

const decode = (
  province: HealthCardProvince.Type,
  printed: string
): Either.Either<HealthCardIdentifier.Type, ParseResult.ParseError> =>
  Schema.decodeEither(HealthCardIdentifier.FromPrinted(province))(printed)

/** The message `printed` fails to decode with under `province`. */
const failureOf = (province: HealthCardProvince.Type, printed: string): string =>
  Either.match(decode(province, printed), {
    onLeft: (error) => error.message,
    onRight: (identifier) => `decoded as ${JSON.stringify(identifier)}`,
  })

describe('HealthCardIdentifier.FromPrinted', () => {
  it('decodes an Ontario card, printed with any separators, to its digits and version code', () => {
    fc.assert(
      fc.property(
        digits.chain((number) =>
          versionCode.chain((code) =>
            printedWithSeparators(`${number}${code}`).map((printed) => ({ number, code, printed }))
          )
        ),
        ({ number, code, printed }) => {
          expect(decode('ON', printed)).toEqual(
            Either.right({
              system: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-on-patient-hcn',
              value: number,
              extension: [
                {
                  url: 'http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code',
                  valueString: code,
                },
              ],
            })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('decodes an Ontario card printing no version code with no extension', () => {
    fc.assert(
      fc.property(
        digits.chain((number) =>
          printedWithSeparators(number).map((printed) => ({ number, printed }))
        ),
        ({ number, printed }) => {
          expect(decode('ON', printed)).toEqual(
            Either.right({ system: HealthCardIdentifier.HealthCardNumberSystem.ON, value: number })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('decodes a British Columbia PHN, printed with any separators, to its digits', () => {
    fc.assert(
      fc.property(
        digits.chain((number) =>
          printedWithSeparators(number).map((printed) => ({ number, printed }))
        ),
        ({ number, printed }) => {
          expect(decode('BC', printed)).toEqual(
            Either.right({
              system: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-bc-patient-healthcare-id',
              value: number,
            })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('decodes an Other number as printed less its separators, letters and all', () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[0-9A-Za-z]{1,14}$/)
          .chain((number) => printedWithSeparators(number).map((printed) => ({ number, printed }))),
        ({ number, printed }) => {
          expect(decode('Other', printed)).toEqual(
            Either.right({
              system: 'https://wildflowerhealth.io/fhir/sid/health-card-number',
              type: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                    code: 'JHN',
                    display: 'Jurisdictional health number (Canada)',
                  },
                ],
              },
              value: number,
            })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keeps an Other number whole, never splitting off a version code', () => {
    expect(decode('Other', 'TREM 4012 5678')).toMatchObject(Either.right({ value: 'TREM40125678' }))
    expect(decode('Other', '1234-567-890 AB')).toEqual(
      Either.right({
        system: HealthCardIdentifier.HealthCardNumberSystem.Other,
        type: HealthCardIdentifier.JURISDICTIONAL_HEALTH_NUMBER_TYPE,
        value: '1234567890AB',
      })
    )
  })

  it("fails a number that is not its province's shape, naming the shape expected", () => {
    const ontario =
      'not an Ontario health card number: expected exactly ten digits, then a version code of up to two letters'
    const britishColumbia = 'not a British Columbia PHN: expected exactly ten digits'
    expect(failureOf('ON', '123456789')).toContain(ontario)
    expect(failureOf('ON', '12345678901')).toContain(ontario)
    expect(failureOf('ON', '1234567890 ABC')).toContain(ontario)
    expect(failureOf('ON', '')).toContain(ontario)
    expect(failureOf('BC', '912345678')).toContain(britishColumbia)
    expect(failureOf('BC', '91234567890')).toContain(britishColumbia)
    expect(failureOf('BC', '9123 456 78X')).toContain(britishColumbia)
    // An Ontario card read as British Columbia's: a PHN has no version code.
    expect(failureOf('BC', '1234-567-890-AB')).toContain(britishColumbia)
    expect(failureOf('Other', ' - ')).toContain(
      'not a health card number: expected something besides spaces and hyphens'
    )
  })

  it('encodes an identifier back to its printed form, a version code after a space', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<HealthCardProvince.Type>('ON', 'BC', 'Other'),
        digits,
        fc.option(versionCode, { nil: '' }),
        (province, number, code) => {
          const printed = province !== 'ON' || code === '' ? number : `${number} ${code}`
          const schema = HealthCardIdentifier.FromPrinted(province)
          expect(Schema.encodeEither(schema)(Schema.decodeSync(schema)(printed))).toEqual(
            Either.right(printed)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it("refuses to encode an identifier in another province's system", () => {
    const british = Schema.decodeSync(HealthCardIdentifier.FromPrinted('BC'))('9123456789')
    expect(Schema.encodeEither(HealthCardIdentifier.FromPrinted('ON'))(british)).toMatchObject({
      _tag: 'Left',
    })
  })

  it('decodes to an identifier fhir-r4 decodes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<HealthCardProvince.Type>('ON', 'BC', 'Other'),
        digits,
        separators,
        fc.option(versionCode, { nil: '' }),
        (province, number, between, code) => {
          const printed = province === 'BC' ? number : `${number}${between}${code}`
          const decoded = Schema.decodeUnknownEither(IdentifierAndReference.IdentifierSchema)(
            Schema.decodeSync(HealthCardIdentifier.FromPrinted(province))(printed)
          )
          expect(decoded).toMatchObject({ _tag: 'Right' })
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

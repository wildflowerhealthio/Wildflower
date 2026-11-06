import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { HealthCardIdentifier } from './index.ts'

const digits = fc.stringMatching(/^\d{10}$/)
const versionCode = fc.stringMatching(/^[A-Z]{1,2}$/)
const separator = fc.constantFrom('', ' ', '  ')

describe('HealthCardIdentifier.of', () => {
  it('writes an Ontario number in value and its version code in the extension', () => {
    fc.assert(
      fc.property(digits, separator, versionCode, (number, between, code) => {
        expect(HealthCardIdentifier.of('ON', `${number}${between}${code}`)).toEqual({
          system: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-on-patient-hcn',
          value: number,
          extension: [
            {
              url: 'http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code',
              valueString: code,
            },
          ],
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('writes an Ontario number printed with no version code with no extension', () => {
    fc.assert(
      fc.property(digits, (number) => {
        expect(HealthCardIdentifier.of('ON', number)).toEqual({
          system: HealthCardIdentifier.HealthCardNumberSystem.ON,
          value: number,
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keeps the rest of an Ontario number as printed', () => {
    expect(HealthCardIdentifier.of('ON', '1234-567-890 A')).toEqual({
      system: HealthCardIdentifier.HealthCardNumberSystem.ON,
      value: '1234-567-890',
      extension: [
        { url: HealthCardIdentifier.ONTARIO_HEALTH_CARD_VERSION_CODE_URL, valueString: 'A' },
      ],
    })
  })

  it('writes a British Columbia PHN as printed, with no version code', () => {
    fc.assert(
      fc.property(fc.oneof(digits, fc.string()), (printed) => {
        expect(HealthCardIdentifier.of('BC', printed)).toEqual({
          system: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-bc-patient-healthcare-id',
          value: printed,
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('writes an identifier fhir-r4 decodes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ON' as const, 'BC' as const),
        digits,
        separator,
        fc.option(versionCode, { nil: '' }),
        (province, number, between, code) => {
          const decoded = Schema.decodeUnknownEither(IdentifierAndReference.IdentifierSchema)(
            HealthCardIdentifier.of(province, `${number}${between}${code}`)
          )
          expect(decoded).toMatchObject({ _tag: 'Right' })
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

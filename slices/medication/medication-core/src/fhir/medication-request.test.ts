import { Schema } from 'effect'
import * as fc from 'fast-check'
import { CanadianCodingSystem, WildflowerExtension } from 'fhir-r4/data-types'
import { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  containedMedicationOf,
  dinOf,
  dosageTextOf,
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
  noteOf,
  repeatsAllowedOf,
  repeatsAvailableOf,
  rexallStoreUrlOf,
  shoppersStoreUrlOf,
} from './medication-request.ts'

const decode = Schema.decodeUnknownSync(MedicationRequest.Schema)

const base = {
  resourceType: 'MedicationRequest',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/1' },
}

const CAREBOOK_DIN_SYSTEM = 'http://schema.carebook.com/v1/fhir/coding/medication-din-code'
const REXALL_STORE_BASE = 'https://www.rexall.ca/storelocator/store/'
const SHOPPERS_STORE_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

// A Rexall request as `rexall-be-well-source` writes it: the Medication is
// contained and pointed at by a `#id` reference, its `code` carries the vendor
// carebook DIN coding beside the canonical twin, the description is still the
// carebook extension (the dialect narrative is a byte-copy of `code.text`), and
// the remaining repeats ride the Wildflower extension.
const rexallRequest = {
  ...base,
  id: 'mr-din',
  authoredOn: '2026-06-01T00:00:00Z',
  medicationReference: { reference: '#med-1' },
  contained: [
    {
      resourceType: 'Medication',
      id: 'med-1',
      text: { status: 'generated', div: 'Atorvastatin 20 mg tablet' },
      code: {
        coding: [
          { system: CAREBOOK_DIN_SYSTEM, code: '02241497', display: 'Atorvastatin 20 mg tablet' },
          {
            system: CanadianCodingSystem.Din,
            code: '02241497',
            display: 'Atorvastatin 20 mg tablet',
          },
        ],
      },
      extension: [
        {
          url: 'http://schemas.carebook.com/v1/fhir/medication/extension/description',
          valueString: '20 mg - Tablet',
        },
      ],
    },
  ],
  requester: { display: 'Dr. Jane Smith' },
  note: [{ text: 'Take with food' }],
  dispenseRequest: {
    numberOfRepeatsAllowed: 3,
    extension: [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: 0 }],
  },
}

// A Shoppers Drug Mart request: no contained Medication — the DIN rides the
// top-level `medicationCodeableConcept.coding` under the canonical system and
// the sig lives in `dosageInstruction.text`.
const shoppersRequest = {
  ...base,
  id: 'mr-sdm',
  medicationCodeableConcept: {
    text: 'LIPITOR',
    coding: [{ system: CanadianCodingSystem.Din, code: '02241497', display: 'atorvastatin' }],
  },
  dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }],
}

/** A non-empty code with no leading/trailing surprises — DINs are 8 digits, but any code reads. */
const codeArbitrary = fc.stringMatching(/^[0-9A-Za-z]{1,12}$/)

/** Coding systems that are *not* the canonical DIN system. */
const otherSystemArbitrary = fc.constantFrom(
  CAREBOOK_DIN_SYSTEM,
  'http://www.nlm.nih.gov/research/umls/rxnorm',
  'http://snomed.info/sct'
)

describe('medicationRequestToMedication', () => {
  test('prefers the codeableConcept text', () => {
    const request = decode({
      ...base,
      id: 'mr1',
      authoredOn: '2024-01-02T03:04:05Z',
      medicationCodeableConcept: { text: 'Abilify 5 mg', coding: [{ display: 'aripiprazole' }] },
    })
    const med = medicationRequestToMedication(request, 'fallback')
    expect(med.id).toBe('mr1')
    expect(med.displayName).toBe('Abilify 5 mg')
    expect(med.status).toBe('active')
    expect(med.authoredOn).toBe('2024-01-02T03:04:05.000Z')
  })

  test('falls back to the first coding display, even when the coding carries a system', () => {
    // The top-level `medicationCodeableConcept.coding.system` decodes to a `URL`;
    // the concept accessor must still surface the sibling `display`.
    const request = decode({
      ...base,
      medicationCodeableConcept: {
        coding: [{ system: CanadianCodingSystem.Din, display: 'atorvastatin calcium' }],
      },
    })
    expect(medicationRequestToMedication(request, 'fallback').displayName).toBe(
      'atorvastatin calcium'
    )
  })

  test('falls back to a medication reference display', () => {
    const request = decode({
      ...base,
      medicationReference: { reference: 'Medication/9', display: 'Actonel DR' },
    })
    expect(medicationRequestToMedication(request, 'fallback').displayName).toBe('Actonel DR')
  })

  test('names the contained Medication by its coding when no concept/reference display', () => {
    const med = medicationRequestToMedication(decode(rexallRequest), 'fallback')
    expect(med.displayName).toBe('Atorvastatin 20 mg tablet')
  })

  test('uses the fallback id and a generic name when nothing is present', () => {
    const med = medicationRequestToMedication(decode(base), 'fallback-7')
    expect(med.id).toBe('fallback-7')
    expect(med.displayName).toBe('Unknown medication')
    expect(med.authoredOn).toBeUndefined()
  })
})

describe('medicationRequestsToMedications', () => {
  test('derives positional fallback keys', () => {
    const meds = medicationRequestsToMedications([decode(base), decode(base)])
    expect(meds.map((m) => m.id)).toEqual(['medication-request-0', 'medication-request-1'])
  })
})

describe('medicationRequestToMedicationView', () => {
  test('extracts DIN, description, prescriber, note and both repeat counts', () => {
    const view = medicationRequestToMedicationView(decode(rexallRequest), 'fallback')
    expect(view.medication.displayName).toBe('Atorvastatin 20 mg tablet')
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
    expect(view.requester).toBe('Dr. Jane Smith')
    expect(view.note).toBe('Take with food')
    expect(view.repeatsAllowed).toBe(3)
    // `valueInteger: 0` is a real value, not "missing".
    expect(view.repeatsAvailable).toBe(0)
    // No `expectedSupplyDuration` on this request → no next-fill estimate.
    expect(view.nextFillDate).toBeNull()
  })

  test('leaves every field null when the request carries none of them', () => {
    const view = medicationRequestToMedicationView(decode(base), 'fallback')
    expect(view.din).toBeNull()
    expect(view.description).toBeNull()
    expect(view.requester).toBeNull()
    expect(view.note).toBeNull()
    expect(view.repeatsAllowed).toBeNull()
    expect(view.repeatsAvailable).toBeNull()
    expect(view.nextFillDate).toBeNull()
    expect(view.rexallStoreUrl).toBeNull()
    expect(view.shoppersStoreUrl).toBeNull()
  })

  test('reads the description out of the narrative once the extension has been promoted', () => {
    // `rexall-be-well-source` promotes the carebook `description` extension
    // into `text.div` and drops the extension. `div` is `xhtml`, so the
    // promoted narrative is markup and the text content is what displays.
    const promoted = {
      ...rexallRequest,
      contained: [
        {
          ...rexallRequest.contained[0],
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml">5 mg &amp; 10 mg &lt;combo&gt;</div>',
          },
          extension: [],
        },
      ],
    }
    const view = medicationRequestToMedicationView(decode(promoted), 'fallback')
    expect(view.description).toBe('5 mg & 10 mg <combo>')
  })

  test('prefers the description extension over a narrative the promotion stood down for', () => {
    // The fixture carries both: the extension's richer description and a
    // narrative holding something else. Reading the narrative first would show
    // the drug name the card already displays.
    const view = medicationRequestToMedicationView(decode(rexallRequest), 'fallback')
    expect(view.description).toBe('20 mg - Tablet')
  })

  test('falls back to the joined dosageInstruction sig for the description', () => {
    const view = medicationRequestToMedicationView(
      decode({
        ...shoppersRequest,
        dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }, { text: 'With food' }],
      }),
      'fallback'
    )
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('Take 1 tablet by mouth once daily\nWith food')
  })

  // A request can't carry `medicationCodeableConcept` beside the
  // `medicationReference` here — fhir-r4 rejects two populated
  // `medication[x]` slots — so the sig is the only fallback left to outrank.
  test('prefers the contained Medication DIN and description over the sig fallback', () => {
    const view = medicationRequestToMedicationView(
      decode({
        ...rexallRequest,
        medicationCodeableConcept: {
          coding: [{ system: CanadianCodingSystem.Din, code: 'DO-NOT-USE' }],
        },
        dosageInstruction: [{ text: 'do-not-use sig' }],
      }),
      'fallback'
    )
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
  })

  test('does not treat validityPeriod.end as a next fill date', () => {
    // `validityPeriod.end` is the *authorization* expiry in R4 — the last date
    // the script may be dispensed against, not when the current supply runs
    // out — so it must not surface as "next fill" on its own.
    const view = medicationRequestToMedicationView(
      decode({
        ...base,
        authoredOn: '2026-06-01T00:00:00Z',
        dispenseRequest: {
          numberOfRepeatsAllowed: 2,
          validityPeriod: { start: '2026-06-01T00:00:00Z', end: '2026-09-01T00:00:00Z' },
        },
      }),
      'fallback'
    )
    expect(view.nextFillDate).toBeNull()
  })

  test('estimates next fill as authoredOn + expectedSupplyDuration', () => {
    const at = (supply: Record<string, unknown>, authoredOn?: string): string | null =>
      medicationRequestToMedicationView(
        decode({
          ...base,
          ...(authoredOn === undefined ? {} : { authoredOn }),
          dispenseRequest: {
            expectedSupplyDuration: supply,
            validityPeriod: { end: '2026-12-31T00:00:00Z' },
          },
        }),
        'fallback'
      ).nextFillDate

    expect(at({ value: 30, unit: 'days', code: 'd' }, '2026-06-01T00:00:00Z')).toBe(
      '2026-07-01T00:00:00.000Z'
    )
    // A UCUM week code advances by whole weeks.
    expect(at({ value: 2, code: 'wk' }, '2026-06-01T00:00:00Z')).toBe('2026-06-15T00:00:00.000Z')
    // An unrecognized supply unit falls back to days.
    expect(at({ value: 30, unit: 'doses', code: '{dose}' }, '2026-06-01T00:00:00Z')).toBe(
      '2026-07-01T00:00:00.000Z'
    )
    // No authored date → no estimate.
    expect(at({ value: 30, code: 'd' })).toBeNull()
  })
})

describe('dinOf', () => {
  it('should read the canonical DIN from medicationCodeableConcept past any other coding', () => {
    fc.assert(
      fc.property(
        codeArbitrary,
        fc.array(fc.tuple(otherSystemArbitrary, codeArbitrary), { maxLength: 3 }),
        (din, others) => {
          const request = decode({
            ...base,
            medicationCodeableConcept: {
              coding: [
                ...others.map(([system, code]) => ({ system, code })),
                { system: CanadianCodingSystem.Din, code: din },
              ],
            },
          })
          expect(dinOf(request)).toBe(din)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read nothing when no coding is under the canonical DIN system', () => {
    // The vendor carebook DIN system, RxNorm and SNOMED CT alike: a vendor
    // coding always has a canonical twin beside it, and printing a non-DIN code
    // as "DIN …" would be a confidently wrong identifier.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.option(otherSystemArbitrary), codeArbitrary), { maxLength: 3 }),
        fc.boolean(),
        (codings, onContained) => {
          const code = {
            coding: codings.map(([system, value]) => ({
              ...(system === null ? {} : { system }),
              code: value,
            })),
          }
          const request = decode(
            onContained
              ? { ...base, contained: [{ resourceType: 'Medication', id: 'm', code }] }
              : { ...base, medicationCodeableConcept: code }
          )
          expect(dinOf(request)).toBeNull()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('containedMedicationOf', () => {
  it('should pick the contained Medication the #id reference names, else the first', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.boolean(),
        (ids, pick, referenced) => {
          const target = ids[pick % ids.length] ?? ''
          const request = decode({
            ...base,
            ...(referenced ? { medicationReference: { reference: `#${target}` } } : {}),
            contained: ids.map((id) => ({ resourceType: 'Medication', id })),
          })
          expect(containedMedicationOf(request)?.id).toBe(referenced ? target : ids[0])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should skip contained entries that are not Medications', () => {
    const request = decode({
      ...base,
      contained: [
        { resourceType: 'Organization', id: 'org' },
        { resourceType: 'Medication', id: 'med' },
      ],
    })
    expect(containedMedicationOf(request)?.id).toBe('med')
  })
})

describe('repeatsAllowedOf / repeatsAvailableOf', () => {
  it('should read the total and the Wildflower remaining-repeats extension', () => {
    fc.assert(
      fc.property(fc.option(fc.nat(99)), fc.option(fc.nat(99)), (allowed, available) => {
        const request = decode({
          ...base,
          dispenseRequest: {
            ...(allowed === null ? {} : { numberOfRepeatsAllowed: allowed }),
            extension:
              available === null
                ? []
                : [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: available }],
          },
        })
        expect(repeatsAllowedOf(request)).toBe(allowed)
        expect(repeatsAvailableOf(request)).toBe(available)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should ignore a remaining-repeats count under any other extension URL', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.nat(99), (url, count) => {
        fc.pre(url !== WildflowerExtension.RepeatsAvailable)
        const request = decode({
          ...base,
          dispenseRequest: { extension: [{ url, valueInteger: count }] },
        })
        expect(repeatsAvailableOf(request)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('rexallStoreUrlOf / shoppersStoreUrlOf', () => {
  const withPerformer = (reference: string): MedicationRequest.Type =>
    decode({ ...base, dispenseRequest: { performer: { reference } } })

  it('should attribute a performer reference to exactly the chain whose base it is under', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(REXALL_STORE_BASE, SHOPPERS_STORE_BASE),
        fc.stringMatching(/^[0-9]{1,6}$/),
        (storeBase, storeId) => {
          const url = `${storeBase}${storeId}`
          const request = withPerformer(url)
          const isRexall = storeBase === REXALL_STORE_BASE
          expect(rexallStoreUrlOf(request)).toBe(isRexall ? url : null)
          expect(shoppersStoreUrlOf(request)).toBe(isRexall ? null : url)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read no store from a performer reference under neither base', () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.constant('Organization/9')), (reference) => {
        fc.pre(!reference.startsWith(REXALL_STORE_BASE))
        fc.pre(!reference.startsWith(SHOPPERS_STORE_BASE))
        const request = withPerformer(reference)
        expect(rexallStoreUrlOf(request)).toBeNull()
        expect(shoppersStoreUrlOf(request)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('noteOf / dosageTextOf', () => {
  it('should newline-join the non-empty texts, or read null when there are none', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }), (texts) => {
        const request = decode({
          ...base,
          note: texts.map((text) => ({ text })),
          dosageInstruction: texts.map((text) => ({ text })),
        })
        const present = texts.filter((text) => text.length > 0)
        const expected = present.length > 0 ? present.join('\n') : null
        expect(noteOf(request)).toBe(expected)
        expect(dosageTextOf(request)).toBe(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('hasRefill', () => {
  it('should be true only when repeats are allowed and at least one remains', () => {
    fc.assert(
      fc.property(fc.option(fc.nat(5)), fc.option(fc.nat(5)), (allowed, available) => {
        const view = medicationRequestToMedicationView(
          decode({
            ...base,
            dispenseRequest: {
              ...(allowed === null ? {} : { numberOfRepeatsAllowed: allowed }),
              extension:
                available === null
                  ? []
                  : [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: available }],
            },
          }),
          'fallback'
        )
        expect(hasRefill(view)).toBe((allowed ?? 0) > 0 && (available ?? 0) > 0)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

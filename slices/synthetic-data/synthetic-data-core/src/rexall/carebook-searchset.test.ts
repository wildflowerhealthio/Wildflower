import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { rexallAccountArbitrary } from '../arbitraries.test-helpers.ts'
import type * as DrugProduct from '../drug-product.ts'
import type * as Prescription from '../prescription.ts'
import { searchsetOf } from './carebook-searchset.ts'

/**
 * Covers the searchset's reading of a per-fill product switch: the list shows
 * a prescription's most recent fill, so it names the product that fill
 * dispensed, as the Shoppers renderer does.
 */

const AS_OF = DateTime.unsafeMake('2026-09-28T12:00:00Z')

/** A hand-written brand tablet, and another manufacturer's at the same strength. */
const brand: DrugProduct.DrugProduct = {
  din: '02000017',
  drugCode: 1,
  brandName: 'Examplex',
  genericName: 'Examplazole',
  strength: { value: 75, unit: 'mcg' },
  form: 'tablet',
  company: 'Example Pharma Inc',
}
const generic: DrugProduct.DrugProduct = {
  ...brand,
  din: '02000025',
  drugCode: 2,
  brandName: 'Apo-Examplazole',
  company: 'Apotex Inc',
}

const interchanged: Prescription.Prescription = {
  key: 'examplazole-1',
  product: brand,
  dosing: { tabletsPerDose: 1, dosesPerDay: 1, direction: null },
  supplyDaysPerFill: 30,
  repeatsAllowed: 5,
  prescriber: { key: 'doctor', display: 'DR A DOCTOR' },
  written: { day: -90, reason: 'start' },
  ended: null,
  fillDays: [-90, -60, -30],
  interchange: { fromFillDay: -60, product: generic },
}

describe('searchsetOf', () => {
  test("property: names an interchanged prescription's product by its most recent fill", () => {
    fc.assert(
      fc.property(rexallAccountArbitrary, (account) => {
        const dins = searchsetOf(AS_OF, account, [interchanged]).entry.flatMap(({ resource }) => [
          ...resource.medicationCodeableConcept.coding.map((coding) => coding.code),
          ...(resource.resourceType === 'MedicationRequest'
            ? resource.contained[0].code.coding.map((coding) => coding.code)
            : []),
        ])
        expect(dins).toEqual([generic.din, generic.din, generic.din])
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})

import { readFileSync, writeFileSync } from 'node:fs'

import type { DrugProduct, Story } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import { DateTime, Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { ShoppersAccount } from './shoppers-account.ts'
import * as ShoppersHar from './shoppers-har.ts'

/**
 * Keeps `har-importer-core`'s committed Shoppers Drug Mart fixture current:
 * the archive {@link ShoppersHar.render} writes from one hand-written family
 * account, which `decode-har.test.ts` decodes. The slice cannot depend on
 * this app, so the file is committed there and checked here, byte for byte.
 * `UPDATE_FIXTURES=1` (the `fixtures:importer` script) rewrites it first.
 */

const FIXTURE_URL = new URL(
  '../../../../slices/importer/har-importer-core/src/fixtures/shoppers-drugmart.generated.har.json',
  import.meta.url
)

const REGENERATE =
  'vp run -F @wildflowerhealthio/synthetic-data-shoppers-drugmart fixtures:importer'

const AS_OF = DateTime.unsafeMake('2026-11-01T00:00:00Z')

const AMOXICILLIN: DrugProduct.DrugProduct = {
  din: '51480840',
  drugCode: 1,
  brandName: 'Amoxil',
  genericName: 'Amoxicillin',
  strength: { value: 500, unit: 'mg' },
  form: 'tablet',
  company: 'Example Pharma Inc',
}

const EXAMPLAZOLE: DrugProduct.DrugProduct = {
  din: '02000017',
  drugCode: 2,
  brandName: 'Apo-Examplazole',
  genericName: 'Examplazole',
  strength: { value: 5, unit: 'mg' },
  form: 'tablet',
  company: 'Example Pharma Inc',
}

const PRESCRIBER = { key: 'prescriber-1', display: 'DR A EXAMPLE' }

const TWICE_DAILY = { tabletsPerDose: 1, dosesPerDay: 2, direction: null } as const

const ONCE_DAILY = { tabletsPerDose: 1, dosesPerDay: 1, direction: null } as const

/** The account holder: two prescriptions, the first filled twice. */
const HOLDER_STORY: Story.Story = {
  person: {
    key: 'person-1',
    givenName: 'First',
    familyName: 'Example',
    gender: 'female',
    age: 40,
    daysSinceBirthday: 100,
    email: 'person-1@example.com',
    postalCode: 'A1A 1A1',
  },
  prescriptions: [
    {
      key: 'person-1-amoxicillin-1',
      product: AMOXICILLIN,
      dosing: TWICE_DAILY,
      supplyDaysPerFill: 10,
      repeatsAllowed: 1,
      prescriber: PRESCRIBER,
      written: { day: -40, reason: 'start' },
      ended: null,
      fillDays: [-40, -30],
    },
    {
      key: 'person-1-examplazole-1',
      product: EXAMPLAZOLE,
      dosing: ONCE_DAILY,
      supplyDaysPerFill: 30,
      repeatsAllowed: 5,
      prescriber: PRESCRIBER,
      written: { day: -20, reason: 'start' },
      ended: null,
      fillDays: [-20],
    },
  ],
  labDraws: [],
}

/** The dependant: two prescriptions, the second filled twice. */
const DEPENDANT_STORY: Story.Story = {
  person: {
    key: 'person-2',
    givenName: 'Second',
    familyName: 'Example',
    gender: 'male',
    age: 12,
    daysSinceBirthday: 200,
    email: 'person-2@example.com',
    postalCode: 'A1A 1A1',
  },
  prescriptions: [
    {
      key: 'person-2-amoxicillin-1',
      product: AMOXICILLIN,
      dosing: TWICE_DAILY,
      supplyDaysPerFill: 10,
      repeatsAllowed: 0,
      prescriber: PRESCRIBER,
      written: { day: -90, reason: 'start' },
      ended: null,
      fillDays: [-90],
    },
    {
      key: 'person-2-examplazole-1',
      product: EXAMPLAZOLE,
      dosing: ONCE_DAILY,
      supplyDaysPerFill: 30,
      repeatsAllowed: 5,
      prescriber: PRESCRIBER,
      written: { day: -60, reason: 'start' },
      ended: null,
      fillDays: [-60, -29],
    },
  ],
  labDraws: [],
}

const ADDRESS = { line1: '1 Example St', city: 'Example', province: 'ON', postalCode: 'A1A 1A1' }

/** A household account: the holder and one dependant. */
const ACCOUNT: ShoppersAccount = {
  pcid: '00000000-0000-4000-8000-000000000010',
  phoneNumber: '5555550100',
  address: ADDRESS,
  store: {
    id: 1234,
    storeName: 'Shoppers Drug Mart #1234',
    phoneNumber: '5555550101',
    address: { ...ADDRESS, line1: '2 Example St' },
  },
  patients: [
    {
      patientId: '00000000-0000-4000-8000-000000000011',
      phoneNumber: '5555550102',
      story: HOLDER_STORY,
    },
    {
      patientId: '00000000-0000-4000-8000-000000000012',
      phoneNumber: '5555550103',
      story: DEPENDANT_STORY,
    },
  ],
}

describe('the committed Shoppers Drug Mart importer fixture', () => {
  test('is the archive ShoppersHar.render writes from the fixed inputs', () => {
    // Arrange
    const rendered = `${Effect.runSync(ShoppersHar.render(AS_OF, ACCOUNT))}\n`
    if (process.env['UPDATE_FIXTURES'] === '1') writeFileSync(FIXTURE_URL, rendered)

    // Act
    const committed = readFileSync(FIXTURE_URL, 'utf8')

    // Assert
    expect(committed, `stale fixture; regenerate it with \`${REGENERATE}\``).toBe(rendered)
  })
})

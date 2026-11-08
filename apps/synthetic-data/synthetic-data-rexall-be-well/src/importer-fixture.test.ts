import { readFileSync, writeFileSync } from 'node:fs'

import type { DrugProduct, Story } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import { DateTime, Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { RexallAccount } from './rexall-account.ts'
import * as RexallHar from './rexall-har.ts'

/**
 * Keeps `har-importer-core`'s committed Rexall Be Well fixture current: the
 * archive {@link RexallHar.render} writes from one hand-written story and
 * account, which `decode-har.test.ts` decodes. The slice cannot depend on
 * this app, so the file is committed there and checked here, byte for byte.
 * `UPDATE_FIXTURES=1` (the `fixtures:importer` script) rewrites it first.
 */

const FIXTURE_URL = new URL(
  '../../../../slices/importer/har-importer-core/src/fixtures/rexall-be-well.generated.har.json',
  import.meta.url
)

const REGENERATE = 'vp run -F @wildflowerhealthio/synthetic-data-rexall-be-well fixtures:importer'

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

/** Two prescriptions, the first filled twice. */
const STORY: Story.Story = {
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
      dosing: { tabletsPerDose: 1, dosesPerDay: 2, direction: null },
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
      dosing: { tabletsPerDose: 1, dosesPerDay: 1, direction: null },
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

const ACCOUNT: RexallAccount = {
  uid: '00000000-0000-4000-8000-000000000001',
  reportingGuid: '00000000-0000-4000-8000-000000000002',
  storeId: '1234',
  pharmacyLocationId: 'pharmacy-1234',
  createdDay: -1000,
  updatedDay: -100,
}

describe('the committed Rexall Be Well importer fixture', () => {
  test('is the archive RexallHar.render writes from the fixed inputs', () => {
    // Arrange
    const rendered = `${Effect.runSync(RexallHar.render(AS_OF, STORY, ACCOUNT))}\n`
    if (process.env['UPDATE_FIXTURES'] === '1') writeFileSync(FIXTURE_URL, rendered)

    // Act
    const committed = readFileSync(FIXTURE_URL, 'utf8')

    // Assert
    expect(committed, `stale fixture; regenerate it with \`${REGENERATE}\``).toBe(rendered)
  })
})

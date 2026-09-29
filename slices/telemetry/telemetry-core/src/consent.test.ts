import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import {
  clearConsent,
  CONSENT_STORAGE_KEY,
  type ConsentStorage,
  readConsent,
  TelemetryConsent,
  writeConsent,
} from './consent.ts'

const consentArb = Arbitrary.make(TelemetryConsent)

describe('readConsent', () => {
  test('reads undecided when nothing is stored', () => {
    expect(readConsent(memoryStorage(), 1)).toBeUndefined()
  })

  test('property: reads back the consent written for the current version', () => {
    fc.assert(
      fc.property(consentArb, (consent) => {
        const storage = memoryStorage()
        writeConsent(storage, consent)

        expect(readConsent(storage, consent.version)).toStrictEqual(consent)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reads undecided when the stored consent answers another version', () => {
    fc.assert(
      fc.property(consentArb, fc.integer(), (consent, currentConsentVersion) => {
        fc.pre(currentConsentVersion !== consent.version)
        const storage = memoryStorage()
        writeConsent(storage, consent)

        expect(readConsent(storage, currentConsentVersion)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each([
    { label: 'not JSON', stored: 'yes please' },
    { label: 'JSON that is not an object', stored: 'true' },
    {
      label: 'a record missing a switch',
      stored: JSON.stringify({
        version: 1,
        crashReports: true,
        decidedAt: '2026-09-29T00:00:00.000Z',
      }),
    },
    {
      label: 'a record with a non-boolean switch',
      stored: JSON.stringify({
        version: 1,
        crashReports: 'yes',
        performance: false,
        decidedAt: '2026-09-29T00:00:00.000Z',
      }),
    },
    {
      label: 'a record with a fractional version',
      stored: JSON.stringify({
        version: 1.5,
        crashReports: true,
        performance: true,
        decidedAt: '2026-09-29T00:00:00.000Z',
      }),
    },
  ])('reads undecided when the stored value is $label', ({ stored }) => {
    const storage = memoryStorage()
    storage.setItem(CONSENT_STORAGE_KEY, stored)

    expect(readConsent(storage, 1)).toBeUndefined()
  })

  test('ignores values under other keys', () => {
    const storage = memoryStorage()
    storage.setItem(
      'another-app.telemetry-consent',
      JSON.stringify({
        version: 1,
        crashReports: true,
        performance: true,
        decidedAt: '2026-09-29T00:00:00.000Z',
      })
    )

    expect(readConsent(storage, 1)).toBeUndefined()
  })
})

describe('storage failures', () => {
  test('a storage error reaches the caller rather than reading or writing a default', () => {
    const storageError = new Error('storage is disabled')
    const failingStorage: ConsentStorage = {
      getItem: () => {
        throw storageError
      },
      setItem: () => {
        throw storageError
      },
      removeItem: () => {
        throw storageError
      },
    }
    const consent: TelemetryConsent = {
      version: 1,
      crashReports: true,
      performance: false,
      decidedAt: '2026-09-29T00:00:00.000Z',
    }

    expect(() => readConsent(failingStorage, 1)).toThrow(storageError)
    expect(() => writeConsent(failingStorage, consent)).toThrow(storageError)
    expect(() => clearConsent(failingStorage)).toThrow(storageError)
  })
})

describe('writeConsent', () => {
  test('property: a later answer replaces an earlier one', () => {
    fc.assert(
      fc.property(consentArb, consentArb, (earlierConsent, laterConsent) => {
        const storage = memoryStorage()
        writeConsent(storage, earlierConsent)
        writeConsent(storage, laterConsent)

        expect(readConsent(storage, laterConsent.version)).toStrictEqual(laterConsent)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('clearConsent', () => {
  test('property: reads undecided after the answer is cleared', () => {
    fc.assert(
      fc.property(consentArb, (consent) => {
        const storage = memoryStorage()
        writeConsent(storage, consent)
        clearConsent(storage)

        expect(readConsent(storage, consent.version)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A {@link ConsentStorage} stand-in backed by a `Map`. */
const memoryStorage = (): ConsentStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

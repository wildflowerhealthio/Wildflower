import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as WatchDevice from './watch-device.ts'

describe('describe', () => {
  it('should name the model, platform and firmware', () => {
    // Arrange
    const watchInfo = {
      platform: 'emery',
      model: 'pebble_time_2_black',
      language: 'en_US',
      firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
    }

    // Act
    const display = WatchDevice.describe(watchInfo)

    // Assert
    expect(display).toBe('pebble_time_2_black (emery, firmware 4.9.1)')
  })

  it('should add a firmware suffix when there is one', () => {
    const watchInfo = {
      platform: 'emery',
      model: 'pebble_time_2_black',
      firmware: { major: 4, minor: 9, patch: 1, suffix: 'beta2' },
    }
    expect(WatchDevice.describe(watchInfo)).toBe(
      'pebble_time_2_black (emery, firmware 4.9.1-beta2)'
    )
  })

  it.each([
    ['undefined', undefined],
    ['no firmware', { platform: 'emery', model: 'pebble_time_2_black' }],
    ['no model', { platform: 'emery', firmware: { major: 4, minor: 9, patch: 1 } }],
    [
      'a fractional firmware version',
      { platform: 'emery', model: 'm', firmware: { major: 4.5, minor: 9, patch: 1 } },
    ],
  ])('should reject watch info with %s', (_, watchInfo) => {
    expect(() => WatchDevice.describe(watchInfo)).toThrow()
  })
})

describe('toReference', () => {
  it('should carry the display and the watch token as the identifier', () => {
    expect(WatchDevice.toReference(WATCH_INFO, 'a1b2c3')).toEqual({
      display: 'pebble_time_2_black (emery, firmware 4.9.1)',
      identifier: {
        system: 'https://developer.repebble.com/docs/pebblekit-js/Pebble/#getWatchToken',
        value: 'a1b2c3',
      },
    })
  })

  // Pebble.getWatchToken() can be missing on an old phone app; without the
  // token no id is reproducible, so the sync fails instead.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['a number', 42],
  ])('should reject a watch token that is %s', (_, watchToken) => {
    expect(() => WatchDevice.toReference(WATCH_INFO, watchToken)).toThrow('Watch token')
  })
})

describe('observationId', () => {
  it('should be stable, and a valid FHIR id', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.array(fc.string()),
        (watchToken, patientId, recordKey) => {
          const device = WatchDevice.toReference(WATCH_INFO, watchToken)
          const id = WatchDevice.observationId(device, patientId, recordKey)
          expect(id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
          expect(WatchDevice.observationId(device, patientId, recordKey)).toBe(id)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should differ between watches, patients and records', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.string({ minLength: 1 }), fc.string(), fc.array(fc.string())),
        fc.tuple(fc.string({ minLength: 1 }), fc.string(), fc.array(fc.string())),
        ([firstToken, firstPatient, firstKey], [secondToken, secondPatient, secondKey]) => {
          fc.pre(
            firstToken !== secondToken ||
              firstPatient !== secondPatient ||
              JSON.stringify(firstKey) !== JSON.stringify(secondKey)
          )
          expect(
            WatchDevice.observationId(
              WatchDevice.toReference(WATCH_INFO, firstToken),
              firstPatient,
              firstKey
            )
          ).not.toBe(
            WatchDevice.observationId(
              WatchDevice.toReference(WATCH_INFO, secondToken),
              secondPatient,
              secondKey
            )
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  // Persisted wire format: a changed derivation would PUT every record under a
  // new id, duplicating everything synced before.
  it('should pin the id of a known record', () => {
    expect(
      WatchDevice.observationId(WatchDevice.toReference(WATCH_INFO, 'a1b2c3'), 'ada-lovelace', [
        'HealthActivity',
        'HealthActivityWalk',
        '1790000000',
      ])
    ).toBe('wf-2dc6c60ebf64d912c49fd386709d61ef')
  })
})

// Helpers

const WATCH_INFO = {
  platform: 'emery',
  model: 'pebble_time_2_black',
  firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
}

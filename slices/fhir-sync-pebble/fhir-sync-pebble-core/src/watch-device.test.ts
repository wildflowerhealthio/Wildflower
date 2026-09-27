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

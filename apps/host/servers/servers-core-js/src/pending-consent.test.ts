import { describe, expect, it } from 'vite-plus/test'

import { keyOf } from './pending-consent.ts'

describe('keyOf', () => {
  it('should name a device request by its code and an app request by its id', () => {
    // Act
    const keys = [
      keyOf({ kind: 'device', userCode: 'ABCD-EFGH', clientName: 'Pebble' }),
      keyOf({ kind: 'oauth', id: 'req-1', clientName: 'Lifting' }),
    ]

    // Assert
    expect(keys).toEqual(['device:ABCD-EFGH', 'oauth:req-1'])
  })

  it('should keep the two flows apart when a code and an id are the same string', () => {
    // Act
    const device = keyOf({ kind: 'device', userCode: 'same', clientName: 'Pebble' })
    const oauth = keyOf({ kind: 'oauth', id: 'same', clientName: 'Pebble' })

    // Assert
    expect(device).not.toBe(oauth)
  })
})

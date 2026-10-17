import { describe, expect, it } from 'vite-plus/test'

import { askOf, keyOf } from './pending-consent.ts'

describe('keyOf', () => {
  it('should name a device request by its code and an app request by its id', () => {
    // Act
    const keys = [
      keyOf({ kind: 'device', userCode: 'ABCD-EFGH', requesterName: 'Pebble' }),
      keyOf({ kind: 'oauth', id: 'req-1', requesterName: 'Lifting' }),
      keyOf({ kind: 'browser', userCode: 'WXYZ-BCDF', requesterName: 'Firefox on Linux' }),
    ]

    // Assert
    expect(keys).toEqual(['device:ABCD-EFGH', 'oauth:req-1', 'browser:WXYZ-BCDF'])
  })

  it('should keep the two flows apart when a code and an id are the same string', () => {
    // Act
    const device = keyOf({ kind: 'device', userCode: 'same', requesterName: 'Pebble' })
    const oauth = keyOf({ kind: 'oauth', id: 'same', requesterName: 'Pebble' })

    // Assert
    expect(device).not.toBe(oauth)
  })
})

describe('askOf', () => {
  it('should say a client wants access, and a browser that it is remote and wants to sign in', () => {
    expect(askOf({ kind: 'oauth', id: 'req-1', requesterName: 'Lifting' })).toBe(
      'Lifting wants access.'
    )
    expect(askOf({ kind: 'device', userCode: 'ABCD-EFGH', requesterName: 'Pebble' })).toBe(
      'Pebble wants access.'
    )
    expect(
      askOf({ kind: 'browser', userCode: 'WXYZ-BCDF', requesterName: 'Firefox on Linux' })
    ).toBe('Firefox on Linux, a remote browser, wants to sign in.')
  })
})

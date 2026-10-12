import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { launchPlaceFor } from './-tiles.tsx'

describe('launchPlaceFor', () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false }

  test('launches here on a plain primary click', () => {
    expect(launchPlaceFor({ button: 0, ...plain })).toBe('here')
  })

  test('launches in a new tab on a ctrl, cmd or shift click, as a link would', () => {
    expect(launchPlaceFor({ button: 0, ...plain, ctrlKey: true })).toBe('newTab')
    expect(launchPlaceFor({ button: 0, ...plain, metaKey: true })).toBe('newTab')
    expect(launchPlaceFor({ button: 0, ...plain, shiftKey: true })).toBe('newTab')
  })

  test('always launches a middle click in a new tab, whatever the modifiers', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (ctrlKey, metaKey, shiftKey) => {
        expect(launchPlaceFor({ button: 1, ctrlKey, metaKey, shiftKey })).toBe('newTab')
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  test('never takes over any other button, so a right click keeps the browser menu', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (button, ctrlKey, metaKey, shiftKey) => {
          expect(launchPlaceFor({ button, ctrlKey, metaKey, shiftKey })).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type { AppRegistration } from '../../../queries.ts'
import { launchPlaceFor, tilePills } from './-tiles.tsx'

// Build a uniform `AppRegistration` — the list shape is no longer a union, so
// `requiresTunnel` (and every flag) rides every row regardless of `kind`.
interface MakeAppOverrides {
  readonly kind: AppRegistration['kind']
  readonly id?: string
  readonly name?: string
  readonly onHomescreen?: boolean
  readonly localOnly?: boolean
  readonly isSmart?: boolean
  readonly requiresTunnel?: boolean
  readonly subtitle?: string
}

const makeApp = (overrides: MakeAppOverrides): AppRegistration => {
  const {
    kind,
    id = 'app',
    name = 'App',
    onHomescreen = true,
    localOnly = false,
    isSmart = false,
    requiresTunnel = false,
    subtitle,
  } = overrides
  return {
    id,
    kind,
    name,
    onHomescreen,
    localOnly,
    isSmart,
    requiresTunnel,
    ...(subtitle === undefined ? {} : { subtitle }),
  }
}

const labels = (app: AppRegistration): readonly string[] => tilePills(app).map((pill) => pill.label)

describe('tilePills', () => {
  test('always shows the kind label', () => {
    expect(labels(makeApp({ kind: 'system' }))).toEqual(['System'])
    expect(labels(makeApp({ kind: 'self-hosted' }))).toEqual(['Self-Hosted'])
    expect(labels(makeApp({ kind: 'cloud' }))).toEqual(['Cloud'])
  })

  test('adds SMART only when smart', () => {
    expect(labels(makeApp({ kind: 'cloud', isSmart: true }))).toContain('SMART')
    expect(labels(makeApp({ kind: 'cloud', isSmart: false }))).not.toContain('SMART')
  })

  test('adds Local-Only only when localOnly', () => {
    expect(labels(makeApp({ kind: 'system', localOnly: true }))).toContain('Local-Only')
    expect(labels(makeApp({ kind: 'system', localOnly: false }))).not.toContain('Local-Only')
  })

  test('adds Tunnel only when requiresTunnel', () => {
    expect(labels(makeApp({ kind: 'cloud', requiresTunnel: true }))).toContain('Tunnel')
    expect(labels(makeApp({ kind: 'cloud', requiresTunnel: false }))).not.toContain('Tunnel')
  })

  test('shows all flags together in order (kind, SMART, Local-Only, Tunnel)', () => {
    expect(
      labels(makeApp({ kind: 'cloud', isSmart: true, localOnly: true, requiresTunnel: true }))
    ).toEqual(['Cloud', 'SMART', 'Local-Only', 'Tunnel'])
  })

  test('every pill carries a unique key', () => {
    const pills = tilePills(
      makeApp({ kind: 'cloud', isSmart: true, localOnly: true, requiresTunnel: true })
    )
    const keys = pills.map((pill) => pill.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

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

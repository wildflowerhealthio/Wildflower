import { describe, expect, test } from 'vite-plus/test'

import type { AppEntry } from '../../../queries.ts'
import { tilePills } from './-tiles.tsx'

const makeApp = (overrides: Partial<AppEntry> & Pick<AppEntry, 'provenance'>): AppEntry => ({
  id: 'app',
  name: 'App',
  enabled: true,
  localOnly: false,
  smart: false,
  requiresTunnel: false,
  ...overrides,
})

const labels = (app: AppEntry): readonly string[] => tilePills(app).map((pill) => pill.label)

describe('tilePills', () => {
  test('always shows the provenance label', () => {
    expect(labels(makeApp({ provenance: 'system' }))).toEqual(['System'])
    expect(labels(makeApp({ provenance: 'self-hosted' }))).toEqual(['Self-Hosted'])
    expect(labels(makeApp({ provenance: 'cloud' }))).toEqual(['Cloud'])
  })

  test('adds SMART only when smart', () => {
    expect(labels(makeApp({ provenance: 'cloud', smart: true }))).toContain('SMART')
    expect(labels(makeApp({ provenance: 'cloud', smart: false }))).not.toContain('SMART')
  })

  test('adds Local-Only only when localOnly', () => {
    expect(labels(makeApp({ provenance: 'system', localOnly: true }))).toContain('Local-Only')
    expect(labels(makeApp({ provenance: 'system', localOnly: false }))).not.toContain('Local-Only')
  })

  test('shows all three flags together in order (provenance, SMART, Local-Only)', () => {
    expect(labels(makeApp({ provenance: 'cloud', smart: true, localOnly: true }))).toEqual([
      'Cloud',
      'SMART',
      'Local-Only',
    ])
  })

  test('every pill carries a unique key', () => {
    const pills = tilePills(makeApp({ provenance: 'cloud', smart: true, localOnly: true }))
    const keys = pills.map((pill) => pill.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

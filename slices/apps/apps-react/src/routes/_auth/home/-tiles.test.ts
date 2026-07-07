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
  removable: false,
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

  test('adds Tunnel only when requiresTunnel', () => {
    expect(labels(makeApp({ provenance: 'cloud', requiresTunnel: true }))).toContain('Tunnel')
    expect(labels(makeApp({ provenance: 'cloud', requiresTunnel: false }))).not.toContain('Tunnel')
  })

  test('shows all flags together in order (provenance, SMART, Local-Only, Tunnel)', () => {
    expect(
      labels(makeApp({ provenance: 'cloud', smart: true, localOnly: true, requiresTunnel: true }))
    ).toEqual(['Cloud', 'SMART', 'Local-Only', 'Tunnel'])
  })

  test('every pill carries a unique key', () => {
    const pills = tilePills(
      makeApp({ provenance: 'cloud', smart: true, localOnly: true, requiresTunnel: true })
    )
    const keys = pills.map((pill) => pill.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

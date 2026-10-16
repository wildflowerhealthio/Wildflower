import { describe, expect, it } from 'vite-plus/test'

import { relayServerUrlFor, serverPresetGroupsFor } from './server-presets.ts'

describe('serverPresetGroupsFor', () => {
  it('launches the demo server at the same URLs for both targets, with a notice only for the launcher', () => {
    const [fhirDemo] = serverPresetGroupsFor('fhir-r4')
    const [wildflowerDemo] = serverPresetGroupsFor('wildflower')

    expect(wildflowerDemo?.presets).toEqual(fhirDemo?.presets)
    expect(fhirDemo?.notice).toBeUndefined()
    expect(wildflowerDemo?.notice).toBe(
      "Wildflower specific features won't be available, but app launching should work."
    )
  })

  it('offers no loopback server to either target', () => {
    const urls = [...serverPresetGroupsFor('fhir-r4'), ...serverPresetGroupsFor('wildflower')]
      .flatMap((group) => group.presets)
      .map((preset) => new URL(preset.url).hostname)

    expect(urls).not.toContain('127.0.0.1')
    expect(urls).not.toContain('localhost')
  })
})

describe('relayServerUrlFor', () => {
  it('builds a relayed server’s origin, its FHIR base', () => {
    expect(relayServerUrlFor('ruth')).toBe('https://ruth.relay.wildflowerhealth.io')
  })

  it('accepts a hyphenated name, trimmed and lower-cased', () => {
    expect(relayServerUrlFor(' Ruth-Lab ')).toBe('https://ruth-lab.relay.wildflowerhealth.io')
  })

  it.each([
    '',
    '   ',
    '-ruth',
    'ruth-',
    '.ruth',
    'ruth.',
    'medication.ruth',
    'ru_th',
    'ruth/x',
    'a@ruth',
    'ruth:1',
  ])('rejects %j', (relayName) => {
    expect(relayServerUrlFor(relayName)).toBeUndefined()
  })
})

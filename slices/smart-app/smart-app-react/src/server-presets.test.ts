import { describe, expect, it } from 'vite-plus/test'

import {
  DEFAULT_SERVER_PRESET_GROUPS,
  hostedServerUrlFor,
  serverPresetGroupsFor,
} from './server-presets.ts'

const LOCAL_ORIGIN = 'http://127.0.0.1:8123'

describe('serverPresetGroupsFor', () => {
  it('launches a SMART app against the local server’s FHIR R4 base, and signs the owner UI in to its origin', () => {
    const [fhirLocal] = serverPresetGroupsFor('fhir-r4', LOCAL_ORIGIN)
    const [wildflowerLocal] = serverPresetGroupsFor('wildflower', LOCAL_ORIGIN)

    expect(fhirLocal?.address).toBe(LOCAL_ORIGIN)
    expect(fhirLocal?.presets.map((preset) => preset.url)).toEqual([`${LOCAL_ORIGIN}/fhir-r4`])
    expect(wildflowerLocal?.address).toBe(LOCAL_ORIGIN)
    expect(wildflowerLocal?.presets.map((preset) => preset.url)).toEqual([LOCAL_ORIGIN])
  })

  it('launches the demo server at the same URLs for both targets, with a notice only for the owner UI', () => {
    const fhirDemo = serverPresetGroupsFor('fhir-r4', LOCAL_ORIGIN)[1]
    const wildflowerDemo = serverPresetGroupsFor('wildflower', LOCAL_ORIGIN)[1]

    expect(wildflowerDemo?.presets).toEqual(fhirDemo?.presets)
    expect(fhirDemo?.notice).toBeUndefined()
    expect(wildflowerDemo?.notice).toBe(
      "Wildflower specific features won't be available, but app launching should work."
    )
  })

  it('labels the local server’s button for what each target does there', () => {
    expect(serverPresetGroupsFor('fhir-r4', LOCAL_ORIGIN)[0]?.presets[0]?.label).toBe('Launch')
    expect(serverPresetGroupsFor('wildflower', LOCAL_ORIGIN)[0]?.presets[0]?.label).toBe('Connect')
  })

  it('launches every SMART app against the desktop host’s loopback FHIR base by default', () => {
    expect(DEFAULT_SERVER_PRESET_GROUPS[0]?.presets[0]?.url).toBe('http://127.0.0.1:8080/fhir-r4')
  })
})

describe('hostedServerUrlFor', () => {
  it('builds a hosted server’s FHIR R4 base for a SMART app and its origin for the owner UI', () => {
    expect(hostedServerUrlFor('fhir-r4', 'ruth')).toBe('https://ruth.wildflowerhealth.io/fhir-r4')
    expect(hostedServerUrlFor('wildflower', 'ruth')).toBe('https://ruth.wildflowerhealth.io')
  })

  it('accepts a nested subdomain, trimmed and lower-cased', () => {
    expect(hostedServerUrlFor('wildflower', ' Medication.Ruth ')).toBe(
      'https://medication.ruth.wildflowerhealth.io'
    )
  })

  it.each([
    '',
    '   ',
    '-ruth',
    'ruth-',
    '.ruth',
    'ruth.',
    'ru..th',
    'ru_th',
    'ruth/x',
    'a@ruth',
    'ruth:1',
  ])('rejects %j', (subdomain) => {
    expect(hostedServerUrlFor('wildflower', subdomain)).toBeUndefined()
  })
})

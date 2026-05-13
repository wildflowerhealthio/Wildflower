import { describe, expect, it } from 'vite-plus/test'

import { BUNDLED_APPS, FHIR_SHARING_ID, PATIENT_BROWSER_ID, findBundled } from './bundled.ts'

describe('BUNDLED_APPS', () => {
  it('has unique ids', () => {
    const ids = BUNDLED_APPS.map((app) => app.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the FHIR sharing action and the patient browser', () => {
    expect(BUNDLED_APPS.some((app) => app.id === FHIR_SHARING_ID && app.kind === 'action')).toBe(
      true
    )
    expect(
      BUNDLED_APPS.some((app) => app.id === PATIENT_BROWSER_ID && app.kind === 'bundled')
    ).toBe(true)
  })

  it('every entry produces a non-empty url for a given origin/launch', () => {
    for (const app of BUNDLED_APPS) {
      expect(app.url('http://localhost:3000', 'launch-token')).not.toBe('')
    }
  })
})

describe('findBundled', () => {
  it('returns the entry whose id matches', () => {
    expect(findBundled(FHIR_SHARING_ID)?.id).toBe(FHIR_SHARING_ID)
  })

  it('returns undefined for unknown ids', () => {
    expect(findBundled('definitely-not-a-bundled-app')).toBeUndefined()
  })
})

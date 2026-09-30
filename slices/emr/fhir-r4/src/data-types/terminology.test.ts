import { describe, expect, it } from 'vite-plus/test'

import {
  CanadianCodingSystem,
  WILDFLOWER_CODE_SYSTEM_BASE,
  WILDFLOWER_EXTENSION_BASE,
  WildflowerCodeSystem,
  WildflowerExtension,
} from './terminology.ts'

describe('terminology', () => {
  it('should keep every Wildflower extension under the shared StructureDefinition base', () => {
    for (const url of Object.values(WildflowerExtension)) {
      expect(url.startsWith(`${WILDFLOWER_EXTENSION_BASE}/`)).toBe(true)
    }
  })

  it('should keep every Wildflower code system under the shared CodeSystem base', () => {
    for (const url of Object.values(WildflowerCodeSystem)) {
      expect(url.startsWith(`${WILDFLOWER_CODE_SYSTEM_BASE}/`)).toBe(true)
    }
  })

  it('should give every Wildflower url a distinct value', () => {
    const urls = [...Object.values(WildflowerCodeSystem), ...Object.values(WildflowerExtension)]
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('should survive a URL round-trip unchanged, as a decoded Coding.system does', () => {
    // `Coding.system` decodes to a `URL`; a reader compares its `href` to these.
    for (const url of [
      ...Object.values(CanadianCodingSystem),
      ...Object.values(WildflowerCodeSystem),
      ...Object.values(WildflowerExtension),
    ]) {
      expect(new URL(url).href).toBe(url)
    }
  })

  it('should spell the workout code system as the lifting slice writes it', () => {
    expect(WildflowerCodeSystem.Workout).toBe(`${WILDFLOWER_CODE_SYSTEM_BASE}/workout`)
  })
})

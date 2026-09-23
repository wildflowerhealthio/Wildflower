import { describe, expect, it } from 'vite-plus/test'

import {
  CanadianCodingSystem,
  WILDFLOWER_EXTENSION_BASE,
  WildflowerExtension,
} from './terminology.ts'

describe('terminology', () => {
  it('should keep every Wildflower extension under the shared StructureDefinition base', () => {
    for (const url of Object.values(WildflowerExtension)) {
      expect(url.startsWith(`${WILDFLOWER_EXTENSION_BASE}/`)).toBe(true)
    }
  })

  it('should survive a URL round-trip unchanged, as a decoded Coding.system does', () => {
    // `Coding.system` decodes to a `URL`; a reader compares its `href` to these.
    for (const url of [
      ...Object.values(CanadianCodingSystem),
      ...Object.values(WildflowerExtension),
    ]) {
      expect(new URL(url).href).toBe(url)
    }
  })
})

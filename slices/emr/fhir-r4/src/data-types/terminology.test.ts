import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CanadianCodingSystem,
  PharmacyStoreLocatorBase,
  storeLocatorUrl,
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

describe('storeLocatorUrl', () => {
  it('should put the store number on the end of its chain page', () => {
    // Act
    const url = storeLocatorUrl(PharmacyStoreLocatorBase.Rexall, '1234')

    // Assert
    expect(url).toBe('https://www.rexall.ca/storelocator/store/1234')
  })

  it('should keep every store page under its chain base, whatever the store number', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(PharmacyStoreLocatorBase)),
        fc.string(),
        (base, storeId) => {
          // Act
          const url = new URL(storeLocatorUrl(base, storeId))

          // Assert — a `/`, `?` or `#` in the number cannot escape the store path.
          expect(url.href.startsWith(base)).toBe(true)
          expect(url.search).toBe('')
          expect(url.hash).toBe('')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

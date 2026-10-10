import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { trimTrailingSlashes } from './fhir-base-url.ts'

describe('trimTrailingSlashes', () => {
  it('should trim every trailing slash off a FHIR base', () => {
    expect(trimTrailingSlashes('https://fhir.example/r4//')).toBe('https://fhir.example/r4')
  })

  it('should leave a base without a trailing slash as it is', () => {
    expect(trimTrailingSlashes('https://fhir.example/r4')).toBe('https://fhir.example/r4')
  })

  it('should never leave a trailing slash, and trim nothing else', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.nat({ max: 3 }), (fhirBaseUrl, slashCount) => {
        // Act
        const trimmed = trimTrailingSlashes(fhirBaseUrl + '/'.repeat(slashCount))

        // Assert
        expect(trimmed.endsWith('/')).toBe(false)
        expect(fhirBaseUrl.startsWith(trimmed)).toBe(true)
        expect(fhirBaseUrl.slice(trimmed.length)).toMatch(/^\/*$/u)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should be idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (fhirBaseUrl) => {
        // Act
        const trimmed = trimTrailingSlashes(fhirBaseUrl)

        // Assert
        expect(trimTrailingSlashes(trimmed)).toBe(trimmed)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

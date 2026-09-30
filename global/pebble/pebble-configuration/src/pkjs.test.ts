import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { decodeWebviewResponse } from './pkjs.ts'

describe('decodeWebviewResponse', () => {
  it('should parse the URI-encoded JSON the settings page handed back', () => {
    expect(decodeWebviewResponse('%7B%22weights%22%3A%5B60%2C50%5D%7D')).toStrictEqual({
      weights: [60, 50],
    })
  })

  it('should decode any JSON value, leaving its shape to the app', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        // Arrange
        const json = JSON.stringify(value)

        // Act / Assert
        expect(decodeWebviewResponse(encodeURIComponent(json))).toStrictEqual(JSON.parse(json))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should refuse a response that is not JSON', () => {
    expect(() => decodeWebviewResponse('%7B%22weights%22%3A')).toThrow()
  })

  it('should refuse a response that is not URI-encoded', () => {
    expect(() => decodeWebviewResponse('%E0%A4%A')).toThrow()
  })
})

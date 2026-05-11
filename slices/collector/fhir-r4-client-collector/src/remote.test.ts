import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { FhirR4Remote } from './remote.ts'

describe('FhirR4Remote', () => {
  describe('firstPage', () => {
    it('should return an HTML source', () => {
      const remote = new FhirR4Remote(defaultConfig, () => {})
      const source = remote.firstPage

      expect('html' in source).toBe(true)
      if ('html' in source) {
        expect(source.html).toContain('Patient')
        expect(source.html).toContain(defaultConfig.rootUrl)
      }
    })

    it('should embed the patient URL in the HTML source', () => {
      fc.assert(
        fc.property(fc.webUrl(), fc.string({ minLength: 1 }), (rootUrl, patientId) => {
          const remote = new FhirR4Remote({ _tag: 'fhir-r4', rootUrl, patientId }, () => {})
          const source = remote.firstPage

          if ('html' in source) {
            expect(source.html).toContain(rootUrl)
          }
        })
      )
    })
  })

  describe('shouldKeepResponse()', () => {
    it('should keep responses matching Patient URLs', () => {
      const remote = new FhirR4Remote(defaultConfig, () => {})

      expect(
        remote.shouldKeepResponse({
          id: 'r1',
          url: 'https://r4.smarthealthit.org/Patient/123',
          status: 200,
          statusText: 'OK',
          headers: {},
        })
      ).toBe(true)
    })
  })

  describe('lifecycle', () => {
    it('should handle register, stream, and finish', () => {
      const remote = new FhirR4Remote(defaultConfig, () => {})
      const encoder = new TextEncoder()
      const patientJson = JSON.stringify({ resourceType: 'Patient', id: '42', gender: 'female' })

      const kept = remote.shouldKeepResponse({
        id: 'lifecycle-1',
        url: 'https://r4.smarthealthit.org/Patient/42',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/fhir+json' },
      })
      expect(kept).toBe(true)

      const half = Math.floor(patientJson.length / 2)
      remote.handleResponseData({
        id: 'lifecycle-1',
        data: encoder.encode(patientJson.slice(0, half)),
      })
      remote.handleResponseData({
        id: 'lifecycle-1',
        data: encoder.encode(patientJson.slice(half)),
      })

      expect(() => remote.handleResponseFinished({ id: 'lifecycle-1' })).not.toThrow()
    })
  })
})

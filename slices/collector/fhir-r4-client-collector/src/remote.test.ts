// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.objectContaining`, `expect.stringContaining`, etc.) are typed as `any`; composing them inside `objectContaining` is the intended idiom

import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { makeFhirR4Remote } from './remote.ts'

const { expectRightToEqual } = utilityExpectations(expect)

describe('makeFhirR4Remote', () => {
  describe('firstPage', () => {
    it('returns an inline HTML bootstrap page that mentions the root URL', () => {
      const remote = makeFhirR4Remote(defaultConfig, () => undefined)
      expect(remote.firstPage).toMatchObject({
        html: expect.stringContaining('Patient'),
      })
      if ('html' in remote.firstPage) {
        expect(remote.firstPage.html).toContain(defaultConfig.rootUrl)
      }
    })

    it('embeds the rootUrl in the bootstrap HTML for any URL + patient id pair', () => {
      fc.assert(
        fc.property(fc.webUrl(), fc.string({ minLength: 1 }), (rootUrl, patientId) => {
          const remote = makeFhirR4Remote({ _tag: 'fhir-r4', rootUrl, patientId }, () => undefined)
          if ('html' in remote.firstPage) {
            expect(remote.firstPage.html).toContain(rootUrl)
          }
        })
      )
    })
  })

  describe('shouldKeepResponse', () => {
    it('keeps responses for Patient and Observation URLs and skips others', () => {
      const remote = makeFhirR4Remote(defaultConfig, () => undefined)
      const base = { status: 200, statusText: 'OK', headers: {} }
      expect(
        remote.shouldKeepResponse({
          ...base,
          id: 'r1',
          url: 'https://r4.smarthealthit.org/Patient/123',
        })
      ).toBe(true)
      expect(
        remote.shouldKeepResponse({
          ...base,
          id: 'r2',
          url: 'https://r4.smarthealthit.org/Observation/456',
        })
      ).toBe(true)
      expect(
        remote.shouldKeepResponse({
          ...base,
          id: 'r3',
          url: 'https://r4.smarthealthit.org/Encounter/789',
        })
      ).toBe(false)
    })
  })

  describe('lifecycle', () => {
    it('routes a complete Patient response through onResult as Right with the decoded patient', () => {
      const onResult =
        vi.fn<
          Parameters<Parameters<typeof makeFhirR4Remote>[1]>[0] extends infer T
            ? (arg: T) => void
            : never
        >()
      const remote = makeFhirR4Remote(defaultConfig, onResult)
      const encoder = new TextEncoder()
      const patientJson = JSON.stringify({ resourceType: 'Patient', id: '42', gender: 'female' })

      remote.shouldKeepResponse({
        id: 'lifecycle-1',
        url: 'https://r4.smarthealthit.org/Patient/42',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/fhir+json' },
      })
      const half = Math.floor(patientJson.length / 2)
      remote.handleResponseData({
        id: 'lifecycle-1',
        data: encoder.encode(patientJson.slice(0, half)),
      })
      remote.handleResponseData({
        id: 'lifecycle-1',
        data: encoder.encode(patientJson.slice(half)),
      })
      remote.handleResponseFinished({ id: 'lifecycle-1' })

      expect(onResult).toHaveBeenCalledOnce()
      const [{ init, result }] = onResult.mock.calls[0]
      expect(init).toMatchObject({
        body: patientJson,
        contentType: 'application/fhir+json',
        url: 'https://r4.smarthealthit.org/Patient/42',
      })
      expectRightToEqual(
        result,
        expect.objectContaining({
          resources: expect.arrayContaining([expect.objectContaining({ id: '42' })]),
          links: expect.arrayContaining([
            expect.objectContaining({ _tag: 'Open', href: expect.stringContaining('Observation') }),
          ]),
        })
      )
    })
  })
})

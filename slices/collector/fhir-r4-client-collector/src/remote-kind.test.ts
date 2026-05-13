// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.objectContaining`, `expect.stringContaining`, etc.) are typed as `any`; composing them inside `objectContaining` is the intended idiom

import { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import { Arbitrary, Effect, Encoding, MutableHashMap } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { InstanceConfig, defaultConfig, firstPage } from './config.ts'
import { type AnyResource, remoteKind } from './remote-kind.ts'

const { expectRightToEqual } = utilityExpectations(expect)

const encoder = new TextEncoder()

type FhirHandlerArgs = Parameters<typeof CollectorBridgeMessageHandler.make<AnyResource>>[0]
type FhirHandler = ReturnType<typeof CollectorBridgeMessageHandler.make<AnyResource>>
type StartArg = Parameters<FhirHandler['ResponseStart']>[0]
type DataArg = Parameters<FhirHandler['ResponseData']>[0]
type FinishArg = Parameters<FhirHandler['ResponseFinished']>[0]

const noopSendMessage: FhirHandlerArgs['sendMessage'] = () => Effect.void

const responseStart = (overrides: { id: string; url: string }): StartArg => ({
  _tag: 'ResponseStart',
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/fhir+json']],
  ...overrides,
})

const responseData = (id: string, body: string): DataArg => ({
  _tag: 'ResponseData',
  id,
  data: Encoding.encodeBase64(encoder.encode(body)),
})

const responseFinished = (id: string): FinishArg => ({ _tag: 'ResponseFinished', id })

describe('firstPage', () => {
  it('returns an inline HTML bootstrap page that mentions the root URL', () => {
    const page = firstPage(defaultConfig)
    expect(page).toMatchObject({ html: expect.stringContaining('Patient') })
    if ('html' in page) {
      expect(page.html).toContain(defaultConfig.rootUrl)
    }
  })

  it('embeds the rootUrl in the bootstrap HTML for any schema-conformant config', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const page = firstPage(config)
        if ('html' in page) {
          expect(page.html).toContain(config.rootUrl)
        }
      })
    )
  })
})

describe('remoteKind driven by a CollectorBridgeMessageHandler', () => {
  it('tracks Patient + Observation URLs and cancels others via sendMessage', () => {
    const sendMessage = vi.fn<FhirHandlerArgs['sendMessage']>(() => Effect.void)
    const handler = CollectorBridgeMessageHandler.make<AnyResource>({
      remote: remoteKind,
      sendMessage,
      onResult: () => undefined,
    })

    Effect.runSync(
      handler.ResponseStart(
        responseStart({ id: 'r1', url: 'https://r4.smarthealthit.org/Patient/123' })
      )
    )
    Effect.runSync(
      handler.ResponseStart(
        responseStart({ id: 'r2', url: 'https://r4.smarthealthit.org/Observation/456' })
      )
    )
    Effect.runSync(
      handler.ResponseStart(
        responseStart({ id: 'r3', url: 'https://r4.smarthealthit.org/Encounter/789' })
      )
    )

    // Encounter is not in the entity set → handler emits a CancelSnifferRequest.
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'CancelSnifferRequest', id: 'r3' })
    expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r1')
    expect(MutableHashMap.keys(handler.inProgressResponses)).toContain('r2')
    expect(MutableHashMap.keys(handler.inProgressResponses)).not.toContain('r3')
  })

  it('routes a complete Patient response through onResult as Right with the decoded patient', () => {
    const onResult = vi.fn<FhirHandlerArgs['onResult']>()
    const handler = CollectorBridgeMessageHandler.make<AnyResource>({
      remote: remoteKind,
      sendMessage: noopSendMessage,
      onResult,
    })
    const patientJson = JSON.stringify({ resourceType: 'Patient', id: '42', gender: 'female' })

    Effect.runSync(
      handler.ResponseStart(
        responseStart({ id: 'lifecycle-1', url: 'https://r4.smarthealthit.org/Patient/42' })
      )
    )
    const half = Math.floor(patientJson.length / 2)
    Effect.runSync(handler.ResponseData(responseData('lifecycle-1', patientJson.slice(0, half))))
    Effect.runSync(handler.ResponseData(responseData('lifecycle-1', patientJson.slice(half))))
    Effect.runSync(handler.ResponseFinished(responseFinished('lifecycle-1')))

    expect(onResult).toHaveBeenCalledOnce()
    const [{ response, result }] = onResult.mock.calls[0]
    expect(response.url).toBe('https://r4.smarthealthit.org/Patient/42')
    expect(response.text()).toBe(patientJson)
    expect(response.headers).toContainEqual(['content-type', 'application/fhir+json'])
    expectRightToEqual(
      result,
      expect.objectContaining({
        resources: expect.arrayContaining([expect.objectContaining({ id: '42' })]),
        links: expect.arrayContaining([
          expect.objectContaining({
            _tag: 'Open',
            href: expect.stringContaining('Observation'),
          }),
        ]),
      })
    )
  })
})

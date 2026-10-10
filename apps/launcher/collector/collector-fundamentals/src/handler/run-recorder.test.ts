import { DateTime, Effect, Either, Encoding, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Extraction } from 'http-extraction-fundamentals'
import {
  echoResponseKind,
  makeExtractionInput,
  runExtraction,
  type Echo,
} from 'http-extraction-fundamentals/test-helpers'
import { CollectorHttpResponse } from '../model/index.ts'
import { runHandlerSync } from './collector-bridge-message-handler.test-helpers.ts'
import * as RunRecorder from './run-recorder.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

const AlphaEntity = echoResponseKind('AlphaEntity', 'alpha')
const BetaEntity = echoResponseKind('BetaEntity', 'beta')
const responseKinds = [AlphaEntity, BetaEntity]

const utf8 = new TextEncoder()

const makeResponse = (
  id: string,
  url: string,
  headers: readonly (readonly [string, string])[] = [['content-type', 'application/json']],
  body: Uint8Array = utf8.encode('{}')
): CollectorHttpResponse => {
  const response = new CollectorHttpResponse(
    id,
    url,
    Option.some('GET' as const),
    200,
    'OK',
    headers,
    DateTime.unsafeMake('2026-01-01T00:00:00Z')
  )
  response.appendChunk(body)
  return response
}

describe('RunRecorder', () => {
  it('records a settled response as an Extraction.Input', () => {
    const recorder = RunRecorder.make()
    const response = makeResponse(
      'r1',
      'https://example.com/alpha/1',
      undefined,
      utf8.encode('{"a":1}')
    )
    recorder.record(response)

    const entries = recorder.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('r1')
    expect(entries[0].url).toBe('https://example.com/alpha/1')
    expect(entries[0].status).toBe(200)
    expect(entries[0].bodyAbsent).toBe(false)
    expect(entries[0].body).toEqual(utf8.encode('{"a":1}'))
  })

  it('drops responses with omitted content types', () => {
    const recorder = RunRecorder.make()
    const response = makeResponse(
      'r1',
      'https://example.com/script.js',
      [['content-type', 'text/javascript']],
      utf8.encode('console.log("hi")')
    )
    recorder.record(response)

    expect(recorder.entries()).toHaveLength(0)
  })

  it('preserves non-UTF-8 body bytes exactly', () => {
    const recorder = RunRecorder.make()
    const body = new Uint8Array([0xff, 0x00, 0xfe, 0x42])
    const response = makeResponse(
      'r1',
      'https://example.com/alpha/1',
      [['content-type', 'application/octet-stream']],
      body
    )
    recorder.record(response)

    expect(recorder.entries()[0].body).toEqual(body)
  })

  it('records multiple responses in settle order', () => {
    const recorder = RunRecorder.make()
    const ids = ['r1', 'r2', 'r3']
    for (const id of ids) {
      recorder.record(makeResponse(id, `https://example.com/alpha/${id}`))
    }

    expect(recorder.entries().map((e) => e.id)).toEqual(ids)
  })
})

describe('RunRecorder integration with SnifferResponseTracker', () => {
  const makeTracker = (
    recorder: RunRecorder.RunRecorder
  ): {
    tracker: SnifferResponseTracker.SnifferResponseTracker<Echo>
    results: SnifferResponseTracker.SniffResult<Echo>[]
  } => {
    const results: SnifferResponseTracker.SniffResult<Echo>[] = []
    const tracker = Effect.runSync(
      SnifferResponseTracker.make<Echo>({
        matchResponseKind: (url, method) =>
          Option.map(Extraction.routeTo(responseKinds, url, method), (r) => r.kind),
        sendMessage: () => Effect.void,
        handleNewSniffResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          }),
        handleGeneratedSteps: () => Effect.void,
        recorder,
      })
    )
    return { tracker, results }
  }

  const driveResponses = (
    tracker: SnifferResponseTracker.SnifferResponseTracker<Echo>,
    responses: readonly Extraction.Input[]
  ): void => {
    for (const response of responses) {
      runHandlerSync(
        tracker.handleResponseStart({
          _tag: 'ResponseStart',
          id: response.id,
          url: response.url,
          method: 'GET',
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      )
      if (response.body.length > 0) {
        runHandlerSync(
          tracker.handleResponseData({
            _tag: 'ResponseData',
            id: response.id,
            data: Encoding.encodeBase64(response.body),
          })
        )
      }
      runHandlerSync(tracker.handleResponseFinished({ _tag: 'ResponseFinished', id: response.id }))
    }
  }

  const exchanges: readonly Extraction.Input[] = [
    makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', body: '{"a":1}' }),
    makeExtractionInput({ id: 'r2', url: 'https://example.com/beta/2', body: 'plain text — ü' }),
    makeExtractionInput({
      id: 'r3',
      url: 'https://example.com/alpha/3',
      headers: [['content-type', 'application/octet-stream']],
      body: new Uint8Array([0xff, 0x00, 0xfe, 0x42]),
    }),
  ]

  it('records every matched response that settles via ResponseFinished', () => {
    const recorder = RunRecorder.make()
    const { tracker } = makeTracker(recorder)
    driveResponses(tracker, exchanges)

    expect(recorder.entries()).toHaveLength(exchanges.length)
    expect(recorder.entries().map((e) => e.id)).toEqual(exchanges.map((e) => e.id))
  })

  it('preserves body bytes through the recorder (non-UTF-8 survives)', () => {
    const recorder = RunRecorder.make()
    const { tracker } = makeTracker(recorder)
    driveResponses(tracker, exchanges)

    const binaryEntry = recorder.entries().find((e) => e.id === 'r3')!
    expect(binaryEntry.body).toEqual(new Uint8Array([0xff, 0x00, 0xfe, 0x42]))
  })

  it('records a response even when the entity parse fails', () => {
    const poisonExchanges: readonly Extraction.Input[] = [
      makeExtractionInput({
        id: 'rp',
        url: 'https://example.com/alpha/1',
        body: 'POISON',
      }),
    ]

    const recorder = RunRecorder.make()
    const { tracker } = makeTracker(recorder)
    driveResponses(tracker, poisonExchanges)

    expect(recorder.entries()).toHaveLength(1)
    expect(recorder.entries()[0].id).toBe('rp')
  })

  it('records a response settled via RequestError', () => {
    const recorder = RunRecorder.make()
    const { tracker } = makeTracker(recorder)

    runHandlerSync(
      tracker.handleResponseStart({
        _tag: 'ResponseStart',
        id: 'err1',
        url: 'https://example.com/alpha/1',
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
      })
    )
    runHandlerSync(
      tracker.handleRequestError({
        _tag: 'RequestError',
        id: 'err1',
        url: 'https://example.com/alpha/1',
        message: 'Connection reset',
      })
    )

    expect(recorder.entries()).toHaveLength(1)
    expect(recorder.entries()[0].id).toBe('err1')
  })

  it('drops omitted content types from the recording', () => {
    const jsExchange = makeExtractionInput({
      id: 'js1',
      url: 'https://example.com/alpha/script',
      headers: [['content-type', 'text/javascript']],
      body: 'console.log("hi")',
    })

    const recorder = RunRecorder.make()
    const { tracker } = makeTracker(recorder)
    driveResponses(tracker, [jsExchange])

    expect(recorder.entries()).toHaveLength(0)
  })
})

describe('recorder entries fed to runExtraction produce the same resources', () => {
  const exchanges: readonly Extraction.Input[] = [
    makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', body: '{"a":1}' }),
    makeExtractionInput({ id: 'r2', url: 'https://example.com/beta/2', body: 'plain text — ü' }),
    makeExtractionInput({
      id: 'r3',
      url: 'https://example.com/alpha/3',
      headers: [['content-type', 'application/octet-stream']],
      body: new Uint8Array([0xff, 0x00, 0xfe, 0x42]),
    }),
  ]

  it('re-extracting from the recorder entries produces the same resources the live tracker produced', () => {
    const recorder = RunRecorder.make()
    const results: SnifferResponseTracker.SniffResult<Echo>[] = []
    const tracker = Effect.runSync(
      SnifferResponseTracker.make<Echo>({
        matchResponseKind: (url, method) =>
          Option.map(Extraction.routeTo(responseKinds, url, method), (r) => r.kind),
        sendMessage: () => Effect.void,
        handleNewSniffResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          }),
        handleGeneratedSteps: () => Effect.void,
        recorder,
      })
    )

    for (const response of exchanges) {
      runHandlerSync(
        tracker.handleResponseStart({
          _tag: 'ResponseStart',
          id: response.id,
          url: response.url,
          method: 'GET',
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      )
      if (response.body.length > 0) {
        runHandlerSync(
          tracker.handleResponseData({
            _tag: 'ResponseData',
            id: response.id,
            data: Encoding.encodeBase64(response.body),
          })
        )
      }
      runHandlerSync(tracker.handleResponseFinished({ _tag: 'ResponseFinished', id: response.id }))
    }

    const liveResources = results.flatMap((r) => (Either.isRight(r) ? r.right.resources : []))

    const reExtracted = Effect.runSync(runExtraction(responseKinds, recorder.entries()))
    const reExtractedResources = reExtracted.batches.flatMap((b) => b.resources)

    expect(reExtractedResources).toEqual(liveResources)
    expect(liveResources).toHaveLength(3)
  })
})

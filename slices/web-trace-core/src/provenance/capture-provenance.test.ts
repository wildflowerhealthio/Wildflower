import { DateTime, Effect, Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { CaptureHeaders } from '../capture/index.ts'
import { fromDocumentReference, isWebTrace } from '../codec/index.ts'
import { traceResourceId } from '../trace-exchange.ts'
import type { CapturedResponse, ReferencableResource } from './capture-provenance.ts'
import {
  captureProvenance,
  makeFhirProvenanceCapture,
  referenceTo,
  toExchangeFields,
  withMetaSource,
} from './capture-provenance.ts'

const STARTED_AT = DateTime.unsafeMake('2026-07-27T10:00:00.000Z')

const SESSION_ID = 'fhir-r4-run-1'

const emptyMeta = {
  lastUpdated: null,
  profile: [],
  security: [],
  tag: [],
  versionId: null,
  source: null,
} as const

const observation = (id: string | null): ReferencableResource => ({
  resourceType: 'Observation',
  id,
  meta: null,
})

const response = (
  bytes: Uint8Array<ArrayBuffer>,
  overrides: Partial<{ requestId: string; headers: CaptureHeaders }> = {}
): CapturedResponse => ({
  id: overrides.requestId ?? 'req-7',
  url: 'https://portal.example.org/Observation?subject=abc',
  status: 200,
  statusText: 'OK',
  headers: overrides.headers ?? ([['content-type', 'application/fhir+json']] as const),
  startedAt: STARTED_AT,
  bytes: () => bytes,
})

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('toExchangeFields', () => {
  it('should project the response facts, renaming only the correlation id', () => {
    expect(toExchangeFields(SESSION_ID, response(utf8('{}')))).toEqual({
      sessionId: SESSION_ID,
      requestId: 'req-7',
      url: 'https://portal.example.org/Observation?subject=abc',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/fhir+json']],
      startedAt: STARTED_AT,
    })
  })
})

describe('referenceTo', () => {
  it('should build a relative reference from the resource type and id', () => {
    expect(referenceTo(observation('abc-1'))).toBe('Observation/abc-1')
  })

  // A link that does not resolve is worse than an absent one — it reads as
  // evidence. `upsertResource` cannot write an id-less resource either.
  it('should refuse to reference a resource with no id', () => {
    expect(referenceTo(observation(null))).toBeNull()
  })
})

describe('withMetaSource', () => {
  it('should set the back-link', () => {
    expect(withMetaSource(observation('abc-1'), 'DocumentReference/run-1-req-7').meta?.source).toBe(
      'DocumentReference/run-1-req-7'
    )
  })

  it('should preserve everything else the resource already carried in meta', () => {
    const withProfile = {
      ...observation('abc-1'),
      meta: { ...emptyMeta, profile: ['http://example.test/StructureDefinition/x'] },
    }
    const linked = withMetaSource(withProfile, 'DocumentReference/t')
    expect(linked.meta?.profile).toEqual(['http://example.test/StructureDefinition/x'])
    expect(linked.meta?.source).toBe('DocumentReference/t')
  })

  it('should not mutate the resource it was handed', () => {
    const original = observation('abc-1')
    withMetaSource(original, 'DocumentReference/t')
    expect(original.meta).toBeNull()
  })
})

describe('captureProvenance', () => {
  it('should store the body verbatim, with no allowlist and no cap', async () => {
    // Deliberately a content type no recorder allowlist carries, and larger
    // than the recorder's 1 MiB default: neither policy applies here.
    const big = new Uint8Array(2 * 1024 * 1024)
    big.fill(7)
    const capture = await Effect.runPromise(
      captureProvenance(
        SESSION_ID,
        response(big, { headers: [['content-type', 'application/octet-stream']] }),
        [observation('abc-1')]
      )
    )
    const attachment = capture.trace.content[0]?.attachment
    expect(attachment?.size).toBe(2 * 1024 * 1024)
    expect(attachment?.contentType).toBe('application/octet-stream')
    expect(attachment?.data).toBe(Encoding.encodeBase64(big))
  })

  it('should store a body that is not UTF-8 decodable rather than dropping it', async () => {
    const invalid = Uint8Array.from([0xff, 0xfe, 0xfd])
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(invalid), [observation('abc-1')])
    )
    expect(capture.trace.content[0]?.attachment.data).toBe(Encoding.encodeBase64(invalid))
  })

  it('should name every produced resource in context.related', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a'), observation('b')])
    )
    expect(capture.trace.context?.related.map((reference) => reference.reference)).toEqual([
      'Observation/a',
      'Observation/b',
    ])
  })

  it('should point every produced resource back at the trace', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a'), observation('b')])
    )
    const expected = `DocumentReference/${traceResourceId({ sessionId: SESSION_ID, requestId: 'req-7' })}`
    expect(capture.linked.map((resource) => resource.meta?.source)).toEqual([expected, expected])
    expect(capture.trace.id).toBe(traceResourceId({ sessionId: SESSION_ID, requestId: 'req-7' }))
  })

  it('should skip an id-less resource in the forward link without dropping it from the output', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a'), observation(null)])
    )
    expect(capture.trace.context?.related.map((reference) => reference.reference)).toEqual([
      'Observation/a',
    ])
    // The resource still comes back — the entity produced it, and dropping it
    // here would let a diagnostic concern change the primary output.
    expect(capture.linked).toHaveLength(2)
  })

  // Every acceptance criterion about reachability rests on the round-trip, not
  // on the shape of the encoded resource.
  it('should round-trip the provenance link back through the codec', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{"resourceType":"Bundle"}')), [
        observation('a'),
        observation('b'),
      ])
    )
    const exchange = await Effect.runPromise(fromDocumentReference(capture.trace))
    expect(exchange.producedResources).toEqual(['Observation/a', 'Observation/b'])
    expect(exchange.sessionId).toBe(SESSION_ID)
    expect(exchange.requestId).toBe('req-7')
  })

  // The 3A viewer finds traces by category and nothing else, so a collector
  // trace has to answer that predicate or it is invisible in the app.
  it('should be found by the same category predicate the viewer searches on', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a')])
    )
    expect(isWebTrace(capture.trace)).toBe(true)
  })

  // Traces are engineering artifacts that happen to contain PHI; an unset
  // subject keeps them out of `Patient/$everything` and clinical exports.
  it('should leave subject unset', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a')])
    )
    // Asserted on the JSON actually written: the encoder leaves the key holding
    // `undefined`, which `JSON.stringify` drops. Asserting on the object alone
    // would also pass for an explicit `null`, which is a different claim.
    expect(JSON.parse(JSON.stringify(capture.trace))).not.toHaveProperty('subject')
  })

  it('should not claim a transfer time it did not measure', async () => {
    const capture = await Effect.runPromise(
      captureProvenance(SESSION_ID, response(utf8('{}')), [observation('a')])
    )
    const exchange = await Effect.runPromise(fromDocumentReference(capture.trace))
    expect(exchange.timings).toEqual({ wait: null, receive: null })
  })

  it('property: two responses in one run produce distinct traces that both name a shared resource', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.string({ minLength: 1, maxLength: 12 })
        ),
        async ([first, second]) => {
          fc.pre(first !== second)
          const shared = observation('shared-1')
          const list = await Effect.runPromise(
            captureProvenance(SESSION_ID, response(utf8('[]'), { requestId: first }), [shared])
          )
          const detail = await Effect.runPromise(
            captureProvenance(SESSION_ID, response(utf8('{}'), { requestId: second }), [shared])
          )
          // Distinct traces...
          expect(list.trace.id).not.toBe(detail.trace.id)
          // ...and both name the resource. This is the direction that survives
          // a resource having several sources; `meta.source` holds only one.
          for (const trace of [list.trace, detail.trace]) {
            expect(trace.context?.related.map((reference) => reference.reference)).toEqual([
              'Observation/shared-1',
            ])
          }
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

describe('makeFhirProvenanceCapture', () => {
  const hook = makeFhirProvenanceCapture('fhir-r4')

  it('should prefix the framework run id into the session id', async () => {
    const result = await Effect.runPromise(hook('run-9', response(utf8('{}')), [observation('a')]))
    const trace = result.diagnostics[0]
    if (trace === undefined) {
      throw new Error('expected the hook to produce a trace')
    }
    expect(trace.id).toBe(traceResourceId({ sessionId: 'fhir-r4-run-9', requestId: 'req-7' }))
    const exchange = await Effect.runPromise(fromDocumentReference(trace))
    expect(exchange.sessionId).toBe('fhir-r4-run-9')
  })

  it('should hand back the linked resources and exactly one trace as a diagnostic', async () => {
    const result = await Effect.runPromise(
      hook('run-9', response(utf8('{}')), [observation('a'), observation('b')])
    )
    expect(result.diagnostics).toHaveLength(1)
    const source = `DocumentReference/${traceResourceId({ sessionId: 'fhir-r4-run-9', requestId: 'req-7' })}`
    expect(result.resources.map((resource) => resource.meta?.source)).toEqual([source, source])
  })
})

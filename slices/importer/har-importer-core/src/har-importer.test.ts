import { Effect, Schema } from 'effect'
import { HarFromJson, emitHar } from 'http-archive'
import { describe, expect, it } from 'vite-plus/test'
import { type TraceBody, type TraceExchange } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { harImporterDescriptor } from './har-importer.ts'
import { defaultHarSettings } from './har-settings.ts'

/**
 * Covers the descriptor's whole read half: `decode` folds a HAR's recognized
 * responses into per-URL sections of labeled resources plus one diagnostic
 * note per response that yielded nothing, with the settings' kind toggles
 * deciding which kinds parse.
 */

/** A base64 SHA-256; the importer never reads it, so any valid digest serves. */
const ANY_HASH = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='

/** A stored FHIR-JSON body, as the capture side would hold it. */
const storedJson = (value: unknown): TraceBody => ({
  _tag: 'StoredBody',
  contentType: 'application/fhir+json',
  data: jsonBody(value),
  size: JSON.stringify(value).length,
  hash: ANY_HASH,
})

const encodeHar = Schema.encode(HarFromJson)

/** Serialize constructed exchanges into `.har` bytes (see decode-har.test.ts on the verb rewrite). */
const harBytesOf = (exchanges: readonly TraceExchange[]): Uint8Array =>
  new TextEncoder().encode(
    Effect.runSync(encodeHar(emitHar(exchanges, { sessionId: 'test-session' }))).replaceAll(
      '"method":"UNKNOWN"',
      '"method":"GET"'
    )
  )

const ROOT = 'https://r4.example.org/baseR4'
const PATIENT_URL = `${ROOT}/Patient/pat-7?_format=json`
const OBSERVATION_URL = `${ROOT}/Observation?subject%3APatient=pat-7&_count=250`
const NOISE_URL = 'https://cdn.example.com/app.7f3c.js'

/** A recognized two-response capture plus one response no kind claims. */
const RECOGNIZED_WITH_NOISE = harBytesOf([
  traceExchange({
    requestId: 'req-0',
    url: PATIENT_URL,
    headers: [['content-type', 'application/fhir+json']],
    body: storedJson({ resourceType: 'Patient', id: 'pat-7' }),
    startedAtMillis: CAPTURE_FLOOR,
  }),
  traceExchange({
    requestId: 'req-1',
    url: OBSERVATION_URL,
    headers: [['content-type', 'application/fhir+json']],
    body: storedJson({
      resourceType: 'Bundle',
      type: 'searchset',
      total: 2,
      entry: [
        {
          resource: {
            resourceType: 'Observation',
            id: 'obs-1',
            status: 'final',
            code: { text: 'Weight' },
          },
        },
        {
          resource: {
            resourceType: 'Observation',
            id: 'obs-2',
            status: 'final',
            code: { text: 'Height' },
          },
        },
      ],
    }),
    startedAtMillis: CAPTURE_FLOOR + 1000,
  }),
  traceExchange({
    requestId: 'req-2',
    url: NOISE_URL,
    body: storedJson({}),
    startedAtMillis: CAPTURE_FLOOR + 2000,
  }),
])

describe('harImporterDescriptor.decode', () => {
  it('should fold a recognized archive into one section per URL, in first-seen order', () => {
    const decoded = Effect.runSync(
      harImporterDescriptor.decode(RECOGNIZED_WITH_NOISE, 'archive.har', defaultHarSettings)
    )

    expect(decoded.sections.map((section) => section.title)).toEqual([PATIENT_URL, OBSERVATION_URL])
    expect(decoded.sections[0]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Patient\//),
    ])
    expect(decoded.sections[1]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Observation\//),
      expect.stringMatching(/^Observation\//),
    ])
  })

  it('should note the response no kind claimed instead of dropping it silently', () => {
    const decoded = Effect.runSync(
      harImporterDescriptor.decode(RECOGNIZED_WITH_NOISE, 'archive.har', defaultHarSettings)
    )

    expect(decoded.notes).toEqual([`Matched no importer: ${NOISE_URL}`])
  })

  it('should fold a disabled kind’s responses into notes instead of sections', () => {
    // Disabling the two Observation kinds leaves the Patient section standing
    // and turns the Observation response into an excluded-by-settings note.
    const settings = {
      disabledKinds: ['ObservationListResponseKind', 'ObservationResponseKind'],
    }

    const decoded = Effect.runSync(
      harImporterDescriptor.decode(RECOGNIZED_WITH_NOISE, 'archive.har', settings)
    )

    expect(decoded.sections.map((section) => section.title)).toEqual([PATIENT_URL])
    expect(decoded.notes).toContain(
      `Excluded — every matching kind is turned off in the settings: ${OBSERVATION_URL}`
    )
  })

  it('should keep the surviving resource keys identical across a settings change', () => {
    // The whole point of `responseId:index` keys: a reviewer's per-resource
    // exclusions and edits keep applying after a kind toggle re-decodes.
    const withAll = Effect.runSync(
      harImporterDescriptor.decode(RECOGNIZED_WITH_NOISE, 'archive.har', defaultHarSettings)
    )
    const withoutObservations = Effect.runSync(
      harImporterDescriptor.decode(RECOGNIZED_WITH_NOISE, 'archive.har', {
        disabledKinds: ['ObservationListResponseKind', 'ObservationResponseKind'],
      })
    )

    const patientKeysBefore = withAll.sections[0]?.resources.map((entry) => entry.key)
    const patientKeysAfter = withoutObservations.sections[0]?.resources.map((entry) => entry.key)
    expect(patientKeysAfter).toEqual(patientKeysBefore)
  })

  it('should fail with a ParseError for bytes that are not a well-formed HAR', () => {
    const result = Effect.runSync(
      Effect.either(
        harImporterDescriptor.decode(
          new TextEncoder().encode('{ not a har }'),
          'archive.har',
          defaultHarSettings
        )
      )
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('ParseError')
  })
})

import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import type { DocumentReference } from 'fhir-r4/resources'
import { HarFromJson, HttpArchive, emitHar } from 'http-archive'
import { SourceDescriptor } from 'http-extraction-fundamentals'
import { MetaSource, PickedFile, FormatDecode, type DecodedFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'
import { type TraceBody, type TraceExchange } from 'web-trace-core'
import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
  isWebTrace,
  toDocumentReference,
} from 'web-trace-core/codec'
import { arbitraries, CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { fhirSources } from './fhir-pool.ts'
import { harImporter } from './har-importer.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'

/**
 * Covers the importer's whole read half: `decode` folds each picked HAR's
 * recognized responses into per-URL sections of labeled resources plus one
 * diagnostic note per response that yielded nothing, with the settings' kind
 * toggles deciding which kinds parse — and owns the source file, minting one
 * per `local` pick, listing it as its own section, and stamping every
 * extracted resource's `meta.source` with it.
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

/** The kind names the settings can turn off — the whole pool recognition routes against. */
const POOL_KIND_NAMES: string[] = SourceDescriptor.poolOf(fhirSources).map((kind) => kind.name)

/** The two kinds that claim the archive's Observation response. */
const OBSERVATION_KINDS = ['ObservationListResponseKind', 'ObservationResponseKind']

/** The fixture archive, as the batch read hands it over. */
const pickedHar = (): PickedFile.Type => ({
  id: '0:archive.har',
  fileName: 'archive.har',
  bytes: RECOGNIZED_WITH_NOISE,
})

/**
 * Decode one pick and take the single result it yields, which must have been
 * read. Asynchronous because minting a pick's archive hashes its bytes through
 * Web Crypto.
 */
const readOne = async (
  file: PickedFile.Type,
  settings: HarSettings = defaultHarSettings
): Promise<FormatDecode.Result<string>> => {
  const result = await Effect.runPromise(harImporter.decode([file], settings))
  if (result.unreadableFiles.length > 0) {
    throw new Error(
      `Expected a readable result, got ${result.unreadableFiles.length} unreadable files`
    )
  }
  return result
}

/** The format's own sections — everything but the minted archive's. */
const extractedSections = (
  sections: readonly DecodedFile.Section[]
): readonly DecodedFile.Section[] => sections.filter((section) => section.title !== 'Source file')

/** Every `meta.source` across the given sections, in section order. */
const metaSourcesOf = (
  sections: readonly DecodedFile.Section[]
): readonly (string | null | undefined)[] =>
  sections.flatMap((section) => section.resources.map((entry) => entry.resource.meta?.source))

describe('harImporter.decode', () => {
  it('should fold a recognized archive into one section per URL, in first-seen order', async () => {
    const decoded = (await readOne(pickedHar())).decoded

    expect(decoded.sections.map((section) => section.title)).toEqual([
      'Source file',
      PATIENT_URL,
      OBSERVATION_URL,
    ])
    expect(extractedSections(decoded.sections)[0]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Patient\//),
    ])
    expect(extractedSections(decoded.sections)[1]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Observation\//),
      expect.stringMatching(/^Observation\//),
    ])
  })

  it('should note the response no kind claimed instead of dropping it silently', async () => {
    const decoded = (await readOne(pickedHar())).decoded

    expect(decoded.notes).toEqual([`Matched no importer: ${NOISE_URL}`])
  })

  it("should fold a disabled kind's responses into notes instead of sections", async () => {
    const decoded = (await readOne(pickedHar(), { disabledKinds: OBSERVATION_KINDS })).decoded

    expect(extractedSections(decoded.sections).map((section) => section.title)).toEqual([
      PATIENT_URL,
    ])
    expect(decoded.notes).toContain(
      `Excluded — every matching kind is turned off in the settings: ${OBSERVATION_URL}`
    )
  })

  it('should keep the surviving resource keys identical across a settings change', async () => {
    const file = pickedHar()
    const withAll = extractedSections((await readOne(file)).decoded.sections)
    const withoutObservations = extractedSections(
      (await readOne(file, { disabledKinds: OBSERVATION_KINDS })).decoded.sections
    )

    expect(withoutObservations[0]?.resources.map((entry) => entry.key)).toEqual(
      withAll[0]?.resources.map((entry) => entry.key)
    )
  })

  it("should list a pick's minted archive as its own first section", async () => {
    const decoded = (await readOne(pickedHar())).decoded
    const sourceSection = decoded.sections[0]

    expect(sourceSection?.title).toBe('Source file')
    // The key is namespaced by the file's slot in the batch, so two archives
    // in one pick cannot collide on it.
    expect(sourceSection?.resources.map((entry) => entry.key)).toEqual([
      `${FormatDecode.keyPrefix(pickedHar())}source-file/archive.har`,
    ])
    expect(sourceSection?.resources[0]?.resource.resourceType).toBe('DocumentReference')
  })

  test('property: every extracted resource names the minted archive, under any kind toggles', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(POOL_KIND_NAMES), async (disabledKinds) => {
        const decoded = (await readOne(pickedHar(), { disabledKinds })).decoded
        const minted = decoded.sections[0]?.resources[0]?.resource

        expect(decoded.sections[0]?.title).toBe('Source file')
        expect(minted?.id).toEqual(expect.any(String))
        for (const source of metaSourcesOf(extractedSections(decoded.sections))) {
          expect(source).toBe(MetaSource.makeReference(minted?.id ?? ''))
        }
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should report bytes that are not a well-formed HAR as one unreadable file', async () => {
    const file: PickedFile.Type = {
      id: '0:archive.har',
      fileName: 'archive.har',
      bytes: new TextEncoder().encode('{ not a har }'),
    }
    const result = await Effect.runPromise(harImporter.decode([file], defaultHarSettings))

    expect(result.decoded.sections).toHaveLength(0)
    expect(result.unreadableFiles).toHaveLength(1)
    expect(result.unreadableFiles[0]?.title).toBe('archive.har')
    expect(result.unreadableFiles[0]?.error._tag).toBe('ParseError')
  })
})

// ---------------------------------------------------------------------------
// The archive this format's importer mints — the schema driven under
// `harImporter`'s own format constants, which is the same context its batch
// `decode` mints under.
// ---------------------------------------------------------------------------

const mintArchive = (
  bytes: Uint8Array,
  fileName = 'portal-session.har'
): Promise<DocumentReference.Type> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat))
  )

const readArchive = (resource: DocumentReference.Type): Promise<PickedFile.Type> =>
  Effect.runPromise(
    Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
      Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat)
    )
  )

const isHarSourceFile = PickedFile.isSourceFile(harImporter.sourceFileFormat)

const { exchange: exchangeArbitrary } = arbitraries(fc)

describe('HAR archive coding', () => {
  it('carries the web-trace har-archive coding on type and category, the raw label, and json content', async () => {
    const resource = await mintArchive(new TextEncoder().encode('{"log":{"version":"1.2"}}'))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(WEB_TRACE_CODE_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(HAR_ARCHIVE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(WEB_TRACE_CODE_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(HAR_ARCHIVE_CODE)
    expect(resource.securityLabel[0]?.coding[0]?.system?.toString()).toBe(
      WEB_TRACE_REDACTION_SYSTEM
    )
    expect(resource.securityLabel[0]?.coding[0]?.code).toBe(WEB_TRACE_RAW_CODE)
    expect(resource.content[0]?.attachment?.contentType).toBe(
      harImporter.sourceFileFormat.contentType
    )
    expect(resource.description).toBe('HAR archive: portal-session.har')
    expect(isHarSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(PickedFile.categoryToken(harImporter.sourceFileFormat)).toBe(
      `${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`
    )
  })
})

describe('HAR archive vs captured trace', () => {
  test('property: the two document kinds are disjoint — neither predicate sees the other', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 512 }),
        exchangeArbitrary,
        async (bytes, exchange) => {
          const sourceFileResource = await mintArchive(bytes)
          const traceResource = await Effect.runPromise(toDocumentReference(exchange))

          expect(isHarSourceFile(sourceFileResource)).toBe(true)
          expect(isWebTrace(sourceFileResource)).toBe(false)
          expect(isWebTrace(traceResource)).toBe(true)
          expect(isHarSourceFile(traceResource)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a trace resource fails to decode as an archive, naming the coding it wants', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            Schema.decode(PickedFile.FromDocumentReference)(
              await Effect.runPromise(toDocumentReference(exchange))
            ).pipe(Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat))
          )
        )
        expect(outcome._tag).toBe('Left')
        if (outcome._tag === 'Left') expect(outcome.left.message).toContain(HAR_ARCHIVE_CODE)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

test('property: stored bytes still parse as an HTTP Archive after the round trip, which is the point of storing them', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(exchangeArbitrary, { minLength: 1, maxLength: 4 }),
      async (exchanges) => {
        const fileText = await Effect.runPromise(
          Schema.encode(HarFromJson)(emitHar(exchanges, { sessionId: 'session-0' }))
        )
        const resource = await mintArchive(new TextEncoder().encode(fileText))
        const stored = await readArchive(resource)

        const log = await Effect.runPromise(
          Schema.decodeUnknown(HttpArchive.LogFromHarJson)(new TextDecoder().decode(stored.bytes))
        )
        expect(log.entries.map((entry) => entry.url).toSorted()).toEqual(
          exchanges.map((exchange) => exchange.url).toSorted()
        )
      }
    ),
    { numRuns: numRunsFor({ base: 25 }) }
  )
})

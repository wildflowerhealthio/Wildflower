import { Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { HarFromJson, emitHar } from 'http-archive'
import { SourceDescriptor } from 'http-extraction-fundamentals'
import {
  PickedFileSource,
  SourceFile,
  SourceFileFhirReference,
  type LabeledSection,
  type PickedFile,
  type ReadUnit,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'
import { type TraceBody, type TraceExchange } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import type { FhirResource } from 'fhir-r4/resources'

import { fhirSources } from './fhir-pool.ts'
import { harImporter } from './har-importer.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'

/**
 * Covers the descriptor's whole read half: `decode` folds each picked HAR's
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

/** The fixture archive, picked from `source` under one file name. */
const pickedHar = (source: PickedFileSource.PickedFileSource): PickedFile => ({
  fileName: 'archive.har',
  bytes: RECOGNIZED_WITH_NOISE,
  source,
})

/**
 * Decode one pick and take the single unit it yields, which must have been
 * read. Asynchronous because minting a local pick's source file hashes its
 * bytes through Web Crypto.
 */
const readOne = async (
  file: PickedFile,
  settings: HarSettings = defaultHarSettings
): Promise<ReadUnit<string>> => {
  const units = await Effect.runPromise(harImporter.decode([file], settings))
  expect(units).toHaveLength(1)
  const unit = units[0]
  if (unit === undefined || !Either.isRight(unit)) {
    throw new Error(`Expected one read unit, got ${unit === undefined ? 'nothing' : 'unreadable'}`)
  }
  return unit.right
}

/** The format's own sections — everything but the minted source file's. */
const extractedSections = (
  sections: readonly LabeledSection<FhirResource>[]
): readonly LabeledSection<FhirResource>[] =>
  sections.filter((section) => section.title !== SourceFile.SECTION_TITLE)

/** Every `meta.source` across the given sections, in section order. */
const metaSourcesOf = (
  sections: readonly LabeledSection<FhirResource>[]
): readonly (string | null | undefined)[] =>
  sections.flatMap((section) => section.resources.map((entry) => entry.resource.meta?.source))

describe('harImporter.decode', () => {
  it('should fold a recognized archive into one section per URL, in first-seen order', async () => {
    const decoded = (await readOne(pickedHar(PickedFileSource.local))).decoded

    expect(decoded.sections.map((section) => section.title)).toEqual([
      SourceFile.SECTION_TITLE,
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
    const decoded = (await readOne(pickedHar(PickedFileSource.local))).decoded

    expect(decoded.notes).toEqual([`Matched no importer: ${NOISE_URL}`])
  })

  it("should fold a disabled kind's responses into notes instead of sections", async () => {
    const decoded = (
      await readOne(pickedHar(PickedFileSource.local), { disabledKinds: OBSERVATION_KINDS })
    ).decoded

    expect(extractedSections(decoded.sections).map((section) => section.title)).toEqual([
      PATIENT_URL,
    ])
    expect(decoded.notes).toContain(
      `Excluded — every matching kind is turned off in the settings: ${OBSERVATION_URL}`
    )
  })

  it('should keep the surviving resource keys identical across a settings change', async () => {
    const file = pickedHar(PickedFileSource.local)
    const withAll = extractedSections((await readOne(file)).decoded.sections)
    const withoutObservations = extractedSections(
      (await readOne(file, { disabledKinds: OBSERVATION_KINDS })).decoded.sections
    )

    expect(withoutObservations[0]?.resources.map((entry) => entry.key)).toEqual(
      withAll[0]?.resources.map((entry) => entry.key)
    )
  })

  it("should list a local pick's minted source file as its own first section", async () => {
    const decoded = (await readOne(pickedHar(PickedFileSource.local))).decoded
    const sourceSection = decoded.sections[0]

    expect(sourceSection?.title).toBe(SourceFile.SECTION_TITLE)
    expect(sourceSection?.resources.map((entry) => entry.key)).toEqual([
      SourceFile.key('archive.har'),
    ])
    expect(sourceSection?.resources[0]?.resource.resourceType).toBe('DocumentReference')
  })

  it('should mint no source file for a server pick and stamp the reference it was picked by', async () => {
    const decoded = (await readOne(pickedHar(PickedFileSource.server('doc-1')))).decoded

    const sources = metaSourcesOf(decoded.sections)

    expect(decoded.sections.map((section) => section.title)).not.toContain(SourceFile.SECTION_TITLE)
    expect(sources.length).toBeGreaterThan(0)
    expect(sources).toEqual(sources.map(() => SourceFileFhirReference.make('doc-1')))
  })

  test('property: every extracted resource names the minted source file, under any kind toggles', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(POOL_KIND_NAMES), async (disabledKinds) => {
        const decoded = (await readOne(pickedHar(PickedFileSource.local), { disabledKinds }))
          .decoded
        const minted = decoded.sections[0]?.resources[0]?.resource

        expect(decoded.sections[0]?.title).toBe(SourceFile.SECTION_TITLE)
        expect(minted?.id).toEqual(expect.any(String))
        for (const source of metaSourcesOf(extractedSections(decoded.sections))) {
          expect(source).toBe(SourceFileFhirReference.make(minted?.id ?? ''))
        }
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should report bytes that are not a well-formed HAR as one unreadable unit', async () => {
    const file: PickedFile = {
      fileName: 'archive.har',
      bytes: new TextEncoder().encode('{ not a har }'),
      source: PickedFileSource.local,
    }
    const units = await Effect.runPromise(harImporter.decode([file], defaultHarSettings))
    const unit = units[0]

    expect(units).toHaveLength(1)
    expect(unit).toBeDefined()
    expect(Either.isLeft(unit)).toBe(true)
    if (unit === undefined || !Either.isLeft(unit)) throw new Error('expected unreadable')
    expect(unit.left._tag).toBe('UnreadableUnit')
    expect(unit.left.title).toBe('archive.har')
    expect(unit.left.error._tag).toBe('ParseError')
  })
})

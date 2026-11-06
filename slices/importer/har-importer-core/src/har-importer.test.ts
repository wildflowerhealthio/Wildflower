import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResource, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { HarFromJson, HttpArchive, emitHar } from '@wildflowerhealthio/http-archive'
import {
  type DecodedFile,
  DecodedFileSet,
  PickedFile,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  REXALL_STU3_BASE_URL,
  REXALL_STU3_PATIENT_SYSTEM,
} from '@wildflowerhealthio/rexall-be-well-source'
import {
  customerUrlOf,
  prescriptionHistoryUrlOf,
  prescriptionStatusUrlOf,
} from '@wildflowerhealthio/shoppers-drugmart-source'
import { type TraceBody, type TraceExchange } from '@wildflowerhealthio/web-trace-core'
import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
  isWebTrace,
  toDocumentReference,
} from '@wildflowerhealthio/web-trace-core/codec'
import {
  arbitraries,
  CAPTURE_FLOOR,
  jsonBody,
  traceExchange,
} from '@wildflowerhealthio/web-trace-core/test-helpers'
import { Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it, test } from 'vite-plus/test'

import { harImporter } from './har-importer.ts'

/**
 * Covers the importer's decode: it folds each picked HAR's recognized
 * responses into per-URL sections of labeled resources plus one diagnostic
 * note per response that yielded nothing, each response routed to its
 * top-ranked kind. The source file it is stored as is minted by
 * `importer-core`'s import stage, and tested there.
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

/** The two kinds that claim the source file's Observation response. */
/** The fixture source file, as the batch read hands it over. */
const pickedHar = (): PickedFile.Type => ({
  id: '0:archive.har',
  fileName: 'archive.har',
  bytes: RECOGNIZED_WITH_NOISE,
})

/** Decode one pick, which must have been read, into its one file set. */
const decodeOne = async (file: PickedFile.Type): Promise<DecodedFileSet.Type> => {
  const result = await Effect.runPromise(harImporter.decode([file], null))
  const [fileSet] = result.fileSets
  if (result.unreadableFiles.length > 0 || fileSet === undefined) {
    throw new Error(
      `Expected a readable result, got ${result.unreadableFiles.length} unreadable files`
    )
  }
  return fileSet
}

/**
 * Decode one pick into its one file set's sections and notes, every record
 * adopted as the import stage adopts it.
 */
const readOne = async (file: PickedFile.Type): Promise<DecodedFile.DecodedFile> =>
  DecodedFileSet.adopt(await decodeOne(file))

describe('harImporter.decode', () => {
  it('should fold a recognized source file into one section per URL, in first-seen order', async () => {
    const decoded = await readOne(pickedHar())

    expect(decoded.sections.map((section) => section.title)).toEqual([PATIENT_URL, OBSERVATION_URL])
    expect(decoded.sections[0]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Patient\//),
    ])
    expect(decoded.sections[1]?.resources.map((entry) => entry.title)).toEqual([
      expect.stringMatching(/^Observation\//),
      expect.stringMatching(/^Observation\//),
    ])
  })

  it("should hand every record over detached, keyed by the server's own id", async () => {
    const fileSet = await decodeOne(pickedHar())
    const records = fileSet.sections.flatMap((section) => section.entries)

    expect(records.map(({ resource }) => resource.id)).toEqual([null, null, null])
    expect(records.map(({ resource }) => DetachedResource.keyOf(resource))).toEqual([
      Option.some({ system: `${ROOT}/Patient`, value: 'pat-7' }),
      Option.some({ system: `${ROOT}/Observation`, value: 'obs-1' }),
      Option.some({ system: `${ROOT}/Observation`, value: 'obs-2' }),
    ])
  })

  it('should title each record by the reference the import stage writes it under', async () => {
    const decoded = await readOne(pickedHar())

    for (const { title, resource } of decoded.sections.flatMap((section) => section.resources)) {
      expect(title).toBe(`${resource.resourceType}/${resource.id}`)
    }
  })

  it('should hold every record of one URL in its one section, whichever response brought it', async () => {
    const observationsWith = (...ids: readonly string[]): unknown => ({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: ids.map((id) => ({
        resource: { resourceType: 'Observation', id, status: 'final', code: { text: 'Weight' } },
      })),
    })
    const decoded = await readOne({
      id: '0:one-url.har',
      fileName: 'one-url.har',
      bytes: harBytesOf(
        [
          { url: OBSERVATION_URL, body: observationsWith('obs-1', 'obs-2') },
          { url: PATIENT_URL, body: { resourceType: 'Patient', id: 'pat-7' } },
          { url: OBSERVATION_URL, body: observationsWith('obs-3') },
        ].map(({ url, body }, index) =>
          traceExchange({
            requestId: `req-${index}`,
            url,
            headers: [['content-type', 'application/fhir+json']],
            body: storedJson(body),
            startedAtMillis: CAPTURE_FLOOR + index * 1000,
          })
        )
      ),
    })

    expect(
      decoded.sections.map((section) => [
        section.title,
        section.resources.map(({ resource }) =>
          resource.resourceType === 'Observation' || resource.resourceType === 'Patient'
            ? resource.identifier[0]?.value
            : null
        ),
      ])
    ).toEqual([
      [OBSERVATION_URL, ['obs-1', 'obs-2', 'obs-3']],
      [PATIENT_URL, ['pat-7']],
    ])
  })

  it('should note the response no kind claimed instead of dropping it silently', async () => {
    const decoded = await readOne(pickedHar())

    expect(decoded.notes).toEqual([`Matched no importer: ${NOISE_URL}`])
  })

  it('should note each duplicate, unparseable, and body-less response exactly once', async () => {
    const duplicatePatientUrl = `${ROOT}/Patient/pat-8?_format=json`
    const unparseableUrl = `${ROOT}/Patient/pat-9?_format=json`
    const bodylessUrl = `${ROOT}/Patient/pat-10?_format=json`
    const fhirJson: readonly (readonly [string, string])[] = [
      ['content-type', 'application/fhir+json'],
    ]
    const decoded = await readOne({
      id: '0:accounting.har',
      fileName: 'accounting.har',
      bytes: harBytesOf(
        [
          {
            url: duplicatePatientUrl,
            body: storedJson({ resourceType: 'Patient', id: 'pat-8' }),
          },
          {
            url: duplicatePatientUrl,
            body: storedJson({ resourceType: 'Patient', id: 'pat-8' }),
          },
          {
            url: unparseableUrl,
            body: storedJson({ resourceType: 'Patient', id: 'pat-9', gender: 42 }),
          },
          {
            url: bodylessUrl,
            body: {
              _tag: 'SkippedBody',
              contentType: 'application/fhir+json',
              size: 118,
              hash: ANY_HASH,
              reason: 'Content type outside the allowlist',
            } satisfies TraceBody,
          },
        ].map(({ url, body }, index) =>
          traceExchange({
            requestId: `req-${index}`,
            url,
            headers: fhirJson,
            body,
            startedAtMillis: CAPTURE_FLOOR + index * 1000,
          })
        )
      ),
    })

    expect(decoded.sections.map((section) => [section.title, section.resources.length])).toEqual([
      [duplicatePatientUrl, 1],
    ])
    expect(decoded.notes).toEqual([
      `Duplicate of an earlier response — not imported: ${duplicatePatientUrl}`,
      `Could not be parsed and will not import: ${unparseableUrl}`,
      `The archive captured no response body: ${bodylessUrl}`,
    ])
  })

  it('should report bytes that are not a well-formed HAR as one unreadable file', async () => {
    const file: PickedFile.Type = {
      id: '0:archive.har',
      fileName: 'archive.har',
      bytes: new TextEncoder().encode('{ not a har }'),
    }
    const result = await Effect.runPromise(harImporter.decode([file], null))

    expect(result.fileSets).toHaveLength(0)
    expect(result.unreadableFiles).toHaveLength(1)
    expect(result.unreadableFiles[0]?.title).toBe('archive.har')
    expect(result.unreadableFiles[0]?.error._tag).toBe('ParseError')
  })
})

/** A Shoppers account that manages one person, whose one fill is in both prescription feeds. */
const SHOPPERS_ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'
const SHOPPERS_PERSON_ID = 'c0ffee00-0000-4000-8000-000000000001'
const SHOPPERS_PRESCRIPTION_ID = 'rx-uuid-1'
const SHOPPERS_STORE_NAME = 'SDM Pharmacy #9000'

/**
 * The Shoppers portal's three XHRs for that account, in the portal's page
 * order, the history also holding an earlier fill of the prescription for
 * each of `historyOnlyFillIds`.
 */
const shoppersExchanges = (historyOnlyFillIds: readonly string[] = []): readonly TraceExchange[] =>
  [
    {
      url: customerUrlOf(SHOPPERS_ACCOUNT_ID),
      body: {
        customer: { patients: [{ id: SHOPPERS_PERSON_ID, firstName: 'Ada' }] },
      },
    },
    {
      url: prescriptionStatusUrlOf(SHOPPERS_PRESCRIPTION_ID),
      body: {
        id: SHOPPERS_PRESCRIPTION_ID,
        patientId: SHOPPERS_PERSON_ID,
        storeId: 9000,
        dispenses: [{ dispenseId: 'disp-1', status: 'COMPLETE', quantityDispensed: 30 }],
      },
    },
    {
      url: prescriptionHistoryUrlOf(SHOPPERS_ACCOUNT_ID),
      body: {
        dispenses: [
          {
            prescriptionId: SHOPPERS_PRESCRIPTION_ID,
            dispenseId: 'disp-1',
            din: '80717730',
            store: { id: 9000, storeName: SHOPPERS_STORE_NAME },
          },
          ...historyOnlyFillIds.map((dispenseId) => ({
            prescriptionId: SHOPPERS_PRESCRIPTION_ID,
            dispenseId,
          })),
        ],
      },
    },
  ].map(({ url, body }, index) =>
    traceExchange({
      requestId: `req-${index}`,
      url,
      body: storedJson(body),
      startedAtMillis: CAPTURE_FLOOR + index * 1000,
    })
  )

/** Every extracted resource of a Shoppers capture of `exchanges`. */
const shoppersResourcesOf = async (
  exchanges: readonly TraceExchange[]
): Promise<readonly FhirResource[]> =>
  (
    await readOne({
      id: '0:shoppers.har',
      fileName: 'shoppers.har',
      bytes: harBytesOf(exchanges),
    })
  ).sections.flatMap((section) => section.resources.map((entry) => entry.resource))

describe('harImporter.decode over a Shoppers capture', () => {
  it.each([
    { order: 'status feed first', exchanges: shoppersExchanges() },
    { order: 'history feed first', exchanges: shoppersExchanges().toReversed() },
  ])(
    'should import a fill in both feeds as one dispense naming the person ($order)',
    async ({ exchanges }) => {
      const resources = await shoppersResourcesOf(exchanges)
      const person = resources.find((resource) => resource.resourceType === 'Patient')
      const dispenses = resources.flatMap((resource) =>
        resource.resourceType === 'MedicationDispense' ? [resource] : []
      )

      expect(
        dispenses.map((dispense) => ({
          subject: dispense.subject?.reference,
          store: dispense.location?.display,
        }))
      ).toEqual([{ subject: `Patient/${person?.id}`, store: SHOPPERS_STORE_NAME }])
    }
  )

  // The history feed names only the account; the prescription names the person.
  it('should file a fill only the history feed holds on the person its prescription is for', async () => {
    const resources = await shoppersResourcesOf(shoppersExchanges(['disp-0']))
    const person = resources.find((resource) => resource.resourceType === 'Patient')

    expect(
      resources.flatMap((resource) =>
        resource.resourceType === 'MedicationDispense' ? [resource.subject?.reference] : []
      )
    ).toEqual([`Patient/${person?.id}`, `Patient/${person?.id}`])
  })
})

// ---------------------------------------------------------------------------
// The source file the import stage mints for this format — the schema driven
// under `harImporter`'s own format constants, which is what `importDecoded`
// provides it under.
// ---------------------------------------------------------------------------

const mintSourceFile = (
  bytes: Uint8Array,
  fileName = 'portal-session.har'
): Promise<PickedFile.SourceFile> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat))
  )

const readSourceFile = (resource: PickedFile.SourceFile): Promise<PickedFile.Type> =>
  Effect.runPromise(
    Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
      Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat)
    )
  )

const isHarSourceFile = PickedFile.isSourceFile(harImporter.sourceFileFormat)

const { exchange: exchangeArbitrary } = arbitraries(fc)

/** The Rexall carebook profile uid of the one person a Rexall capture is about. */
const REXALL_PROFILE_UID = 'uid-abc-123'

/** The tunnel host the Rexall portal's XHRs go to. */
const REXALL_TUNNEL = 'https://rexall-prd-tunnel.letsbewell.ca/enduser'

/**
 * The Rexall portal's two XHRs: the profile, and the prescription list with a
 * fill and its dispense, the request naming its prescriber the way carebook
 * does, by `requester.agent.display` behind an empty `reference`.
 */
const rexallExchanges = (
  requester: Record<string, unknown> = { agent: { reference: '', display: 'DR PATEL' } }
): readonly TraceExchange[] =>
  [
    {
      url: `${REXALL_TUNNEL}/profile/v2/me`,
      body: {
        data: {
          identifiers: { uid: REXALL_PROFILE_UID },
          names: { firstName: 'Jordan', lastName: 'Rivera' },
          birthDate: '1985-07-14',
        },
      },
    },
    {
      url: `${REXALL_TUNNEL}/health/v1/fhir/stu3/pharmacy/Location?subject=Patient/${REXALL_PROFILE_UID}`,
      body: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resourceType: 'MedicationRequest', status: 'active', intent: 'order' },
          { resourceType: 'MedicationDispense', status: 'completed' },
        ].map((resource) => ({
          resource: {
            ...resource,
            id: 'rx-1',
            medicationCodeableConcept: { text: 'Atorvastatin 20 mg tablet' },
            subject: { reference: `Patient/${REXALL_PROFILE_UID}`, display: '' },
            ...(resource.resourceType === 'MedicationRequest' ? { requester } : {}),
          },
        })),
      },
    },
  ].map(({ url, body }, index) =>
    traceExchange({
      requestId: `req-${index}`,
      url,
      body: storedJson(body),
      startedAtMillis: CAPTURE_FLOOR + index * 1000,
    })
  )

describe('harImporter.decode over a Rexall capture', () => {
  it('should name one Patient and the prescriber by printed name as its referents', async () => {
    const result = await readOne({
      id: '0:rexall.har',
      fileName: 'rexall.har',
      bytes: harBytesOf(rexallExchanges()),
    })

    const referents = Effect.runSync(Referent.discover([result]))

    expect(
      referents.map(({ _tag, logicalReference }) => [
        _tag,
        logicalReference.type,
        logicalReference.identifier.system.href,
        logicalReference.identifier.value,
      ])
    ).toEqual([
      ['AsResource', 'Patient', REXALL_STU3_PATIENT_SYSTEM, REXALL_PROFILE_UID],
      ['ByMentionOnly', 'Practitioner', Practitioner.NAME_IDENTIFIER_SYSTEM, 'DR PATEL'],
    ])
  })
})

describe('harImporter.decode over a Rexall capture naming a prescriber carebook does not serve', () => {
  // The import holds no Practitioner keyed by that id, so the reference stays
  // logical rather than pointing at an id nothing is stored under, and the
  // identity map offers it as a provider to link.
  it('should name the prescriber as a referent by mention, by its carebook id', async () => {
    const result = await readOne({
      id: '0:rexall.har',
      fileName: 'rexall.har',
      bytes: harBytesOf(rexallExchanges({ agent: { reference: 'Practitioner/dr-1' } })),
    })

    const request = result.sections
      .flatMap((section) => section.resources)
      .find(({ resource }) => resource.resourceType === 'MedicationRequest')?.resource
    expect(
      request?.resourceType === 'MedicationRequest' ? request.requester?.reference : ''
    ).toBeNull()
    expect(
      Effect.runSync(Referent.discover([result])).map(({ _tag, logicalReference }) => [
        _tag,
        logicalReference.type,
        logicalReference.identifier.system.href,
        logicalReference.identifier.value,
      ])
    ).toEqual([
      ['AsResource', 'Patient', REXALL_STU3_PATIENT_SYSTEM, REXALL_PROFILE_UID],
      ['ByMentionOnly', 'Practitioner', `${REXALL_STU3_BASE_URL}/Practitioner`, 'dr-1'],
    ])
  })
})

describe('HAR archive coding', () => {
  it('carries the web-trace har-archive coding on type and category, the raw label, and json content', async () => {
    const resource = await mintSourceFile(new TextEncoder().encode('{"log":{"version":"1.2"}}'))

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
          const sourceFileResource = await mintSourceFile(bytes)
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

  test('property: a trace resource fails to decode as a source file, naming the coding it wants', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            Schema.decodeUnknown(PickedFile.FromDocumentReference)(
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

test('property: stored bytes still parse as an HTTP Source file after the round trip, which is the point of storing them', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(exchangeArbitrary, { minLength: 1, maxLength: 4 }),
      async (exchanges) => {
        const fileText = await Effect.runPromise(
          Schema.encode(HarFromJson)(emitHar(exchanges, { sessionId: 'session-0' }))
        )
        const resource = await mintSourceFile(new TextEncoder().encode(fileText))
        const stored = await readSourceFile(resource)

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

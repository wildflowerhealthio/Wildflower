/**
 * The files the screen tests pick: the canonical DICOM study, the HAR the
 * FHIR pool recognizes, and the archive wire the server list serves.
 *
 * @remarks
 * Their own module rather than inline in `importer-screen.test.tsx`: building
 * them is what pulls the file-format packages in, and the screen test sits at
 * the slice's dependency ceiling without them.
 *
 * @packageDocumentation
 */
import { writeDicom, type DicomTagMap } from 'dicom/test-helpers'
import { DateTime, Effect, Schema } from 'effect'
import { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'har-importer-core/source-file'
import { emitHar, HarFromJson } from 'http-archive'
import type { TraceBody } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

/** The tags every file of the canonical study shares. */
const STUDY_TAGS: DicomTagMap = {
  StudyInstanceUID: '1.2.3.4.5',
  PatientID: 'P001',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  Modality: 'CT',
  AccessionNumber: 'ACC001',
}

/**
 * One `.dcm` of the canonical study, as a `File` for the OS-picker path.
 *
 * @param name - The file's name, as the picker reads it
 * @param tags - What this file states beyond {@link STUDY_TAGS}
 * @returns The written DICOM file
 */
const dicomFile = (name: string, tags: DicomTagMap): File =>
  new File(
    [
      // Re-wrapped through the ambient `Uint8Array`, the same single-realm
      // fix `RealmSafeTextEncoder` makes for jsdom's encoder.
      new Uint8Array(writeDicom({ ...STUDY_TAGS, ...tags })),
    ],
    name,
    { type: 'application/dicom' }
  )

/** A stored FHIR-JSON body, as the capture side would hold it. */
const storedJson = (value: unknown): TraceBody => ({
  _tag: 'StoredBody',
  contentType: 'application/fhir+json',
  data: jsonBody(value),
  size: JSON.stringify(value).length,
  hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
})

/** A minimal FHIR searchset wrapping the given resources. */
const searchsetOf = (...resources: readonly unknown[]): Record<string, unknown> => ({
  resourceType: 'Bundle',
  type: 'searchset',
  total: resources.length,
  entry: resources.map((resource) => ({ resource })),
})

/**
 * A HAR the `fhir-r4` importer recognizes: a Patient read and an Observation
 * searchset off one server, built through `web-trace-core`'s own `emitHar` so it
 * is shaped exactly like a real capture. Previews to 1 Patient + 2 Observations.
 */
const RECOGNIZED_HAR: string = Effect.runSync(
  Schema.encode(HarFromJson)(
    emitHar(
      [
        traceExchange({
          requestId: 'req-0',
          url: 'https://r4.example.org/baseR4/Patient/pat-7?_format=json',
          headers: [['content-type', 'application/fhir+json']],
          body: storedJson({ resourceType: 'Patient', id: 'pat-7' }),
          startedAtMillis: CAPTURE_FLOOR,
        }),
        traceExchange({
          requestId: 'req-1',
          url: 'https://r4.example.org/baseR4/Observation?subject%3APatient=pat-7&_count=250',
          headers: [['content-type', 'application/fhir+json']],
          body: storedJson(
            searchsetOf(
              {
                resourceType: 'Observation',
                id: 'obs-1',
                status: 'final',
                code: { text: 'Weight' },
              },
              {
                resourceType: 'Observation',
                id: 'obs-2',
                status: 'final',
                code: { text: 'Height' },
              }
            )
          ),
          startedAtMillis: CAPTURE_FLOOR + 1000,
        }),
      ],
      { sessionId: 'test-session' }
    )
  )
  // `emitHar` writes `request.method: 'UNKNOWN'` (the capture side never
  // observed a verb); rewrite the wire so the FHIR pool's `verb: ['GET']`
  // matchers claim these entries, mirroring what a real capture that
  // observed the method would carry through.
).replaceAll('"method":"UNKNOWN"', '"method":"GET"')

/** Text as base64, the way the archive codec stores the file's bytes. */
const base64 = Schema.encodeSync(Schema.StringFromBase64)

/** One archive `DocumentReference` wire, decodable by the codec and rowable by the list. */
const archiveWire = (fields: {
  readonly id: string
  readonly fileName: string
  readonly harText: string
}): unknown => {
  const coding = [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }]
  const iso = DateTime.formatIso(DateTime.unsafeFromDate(new Date('2026-08-13T10:00:00.000Z')))
  return {
    resourceType: 'DocumentReference',
    id: fields.id,
    status: 'current',
    type: { coding },
    category: [{ coding }],
    date: iso,
    content: [
      {
        attachment: {
          contentType: 'application/json',
          data: base64(fields.harText),
          title: fields.fileName,
          creation: iso,
        },
      },
    ],
  }
}

export { archiveWire, dicomFile, RECOGNIZED_HAR }
export type { DicomTagMap }

/**
 * The files the screen tests pick: the canonical DICOM study, the HAR the
 * FHIR pool recognizes, and the source file wire the server list serves.
 *
 * @remarks
 * Their own module rather than inline in `importer-screen.test.tsx`: building
 * them is what pulls the file-format packages in, and the screen test sits at
 * the slice's dependency ceiling without them.
 *
 * @packageDocumentation
 */
import { writeDicom, type DicomTagMap } from 'dicom/test-helpers'
import { Effect, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'
import { emitHar, HarFromJson } from 'http-archive'
import { PickedFile } from 'importer-fundamentals'
import type { TraceBody } from 'web-trace-core'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

/** The tags every file of the canonical study shares. */
const STUDY_TAGS: DicomTagMap = {
  StudyInstanceUID: '1.2.3.4.5',
  PatientID: 'P001',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  Modality: 'CT',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
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

/** One source file already on the server: its minted id and the wire it is served as. */
interface StoredSourceFile {
  readonly id: string
  readonly fileName: string
  readonly wire: unknown
}

/**
 * The source file a file of this format would be stored as, minted exactly as the
 * decode mints it.
 *
 * @param format - The format's source file constants, from its registry entry
 * @param fileName - The stored file's name
 * @param text - The stored file's contents
 * @returns The source file's id and the FHIR JSON a server would serve
 *
 * @remarks
 * Minted rather than hand-built, because the point of a server-picked file is
 * that re-picking it mints *the same* sourceFile: the id is deterministic in the
 * bytes, the name and the coding system, so the row a re-decode produces is the
 * one already stored and the server diff reads it as `unchanged`.
 */
const storedSourceFile = async (
  format: PickedFile.FormatValue,
  fileName: string,
  text: string
): Promise<StoredSourceFile> => {
  const bytes = new Uint8Array(new TextEncoder().encode(text))
  const resource = await Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({ id: `0:${fileName}`, fileName, bytes }).pipe(
      Effect.provideService(PickedFile.Format, format)
    )
  )
  const wire = await Effect.runPromise(Schema.encode(DocumentReference.Schema)(resource))
  return { id: resource.id ?? '', fileName, wire }
}

export { dicomFile, RECOGNIZED_HAR, storedSourceFile }
export type { DicomTagMap, StoredSourceFile }

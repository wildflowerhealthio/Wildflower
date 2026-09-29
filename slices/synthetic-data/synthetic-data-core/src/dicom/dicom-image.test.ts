import { DicomHeader } from 'dicom'
import { detectDicom, dicomImporter } from 'dicom-importer-core'
import { parseDicom } from 'dicom-parser'
import { writeDicom } from 'dicom/test-helpers'
import { DateTime, Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { ageOn, asOfArbitrary, personArbitrary } from '../arbitraries.test-helpers.ts'
import type * as Person from '../person.ts'
import {
  DEIDENTIFIED_EXPORT_ELEMENTS,
  deidentifiedFileArbitrary,
  parserKeyOf,
  PRIVATE_TAGS,
  SOURCE_FRAME_OF_REFERENCE_UID,
  textOf,
  valueBytesOf,
  withElementsSpliced,
} from './dicom-fixture.test-helpers.ts'
import * as DicomImage from './dicom-image.ts'
import type * as Part10 from './part10.ts'

/**
 * Re-identification over generated de-identified files and people: the header
 * says what the re-identification asked for, read back by `dicom-parser` and
 * `dicom`'s `DicomHeader`; everything else about the file is kept or dropped
 * as `DicomImage` states; and the DICOM importer reads the result onto the
 * given Patient.
 */

const RUNS = numRunsFor({ base: 25 })

/** Each import property decodes every generated file through the importer. */
const IMPORT_TIMEOUT_MILLIS = 60_000

const reidentificationArbitrary: fc.Arbitrary<DicomImage.Reidentification> = fc.record({
  person: personArbitrary('person-1'),
  patientId: fc.stringMatching(/^[A-Z0-9]{1,16}$/),
  studyDay: fc.integer({ min: -730, max: 0 }),
  accessionNumber: fc.option(fc.stringMatching(/^[0-9]{1,16}$/), { nil: undefined }),
  imageKey: fc.constantFrom('chest-x-ray', 'hand-x-ray', 'image-1'),
})

const caseArbitrary = fc.record({
  asOf: asOfArbitrary,
  file: deidentifiedFileArbitrary,
  reidentification: reidentificationArbitrary,
})

const reidentified = (
  asOf: DateTime.Utc,
  file: Uint8Array,
  reidentification: DicomImage.Reidentification
): Uint8Array =>
  Either.getOrThrowWith(
    DicomImage.reidentify(asOf, file, reidentification),
    (error) => new Error(error.reason)
  )

const headerOf = (file: Uint8Array): DicomHeader.Type =>
  Either.getOrThrowWith(DicomHeader.tryFromDicomFile(file), (error) => new Error(error.reason))

/** The story day's calendar date as `DA`, reckoned here from epoch days rather than by `StoryDay`. */
const expectedDaOf = (asOf: DateTime.Utc, studyDay: number): string => {
  const asOfMidnight = Math.floor(DateTime.toEpochMillis(asOf) / 86_400_000) * 86_400_000
  return new Date(asOfMidnight + studyDay * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')
}

const dateOfDa = (da: string): DateTime.Utc =>
  DateTime.unsafeMake(`${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}T00:00:00Z`)

/** A UID the standard accepts: digits and dots, no empty or zero-led arc, at most 64 characters. */
const isValidUid = (uid: string): boolean =>
  uid.length <= 64 && /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/.test(uid)

const decodeReference = Schema.decodeSync(IdentifierAndReference.ReferenceSchema)

const PHARMACY_PATIENT = decodeReference({
  reference: 'Patient/pharmacy-patient-1',
  identifier: { system: 'https://example.com/fhir/sid/pharmacy', value: 'P-1' },
})

describe('DicomImage.reidentify', () => {
  test('property: writes the patient, the story day and fresh UIDs into the header', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const source = headerOf(file)
        const header = headerOf(reidentified(asOf, file, reidentification))
        const { person } = reidentification
        const studyDa = expectedDaOf(asOf, reidentification.studyDay)

        expect(header.patientId).toBe(reidentification.patientId)
        expect(header.patientName).toEqual({
          family: person.familyName,
          given: person.givenName,
          text: `${person.familyName} ${person.givenName}`,
        })
        expect(header.patientSex).toBe(person.gender === 'male' ? 'M' : 'F')
        const birthDate = header.patientBirthDate ?? ''
        expect(ageOn(dateOfDa(birthDate), DateTime.startOf(asOf, 'day'))).toBe(person.age)
        expect(header.studyDate).toBe(studyDa)
        expect(header.studyTime).toMatch(/^(0[89]|1[0-7])[0-5][0-9][0-5][0-9]$/)
        expect(header.accessionNumber).toBe(reidentification.accessionNumber)

        const uids = [header.studyInstanceUid, header.seriesInstanceUid, header.sopInstanceUid]
        for (const uid of uids) {
          expect(isValidUid(uid)).toBe(true)
          expect(uid.startsWith(`${DicomImage.UID_ROOT}.`)).toBe(true)
        }
        expect(new Set(uids).size).toBe(3)
        expect(uids).not.toContain(source.studyInstanceUid)
        expect(header.sopClassUid).toBe(source.sopClassUid)
        expect(header.modality).toBe(source.modality)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: dates every acquisition and content attribute on the story day, and drops the rest', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const dataSet = parseDicom(reidentified(asOf, file, reidentification))
        const studyDa = expectedDaOf(asOf, reidentification.studyDay)
        const studyTm = textOf(dataSet, 0x0008_0030)
        for (const dateTag of [0x0008_0020, 0x0008_0021, 0x0008_0022, 0x0008_0023]) {
          expect(textOf(dataSet, dateTag)).toBe(studyDa)
        }
        for (const timeTag of [0x0008_0031, 0x0008_0032, 0x0008_0033]) {
          expect(textOf(dataSet, timeTag)).toBe(studyTm)
        }
        expect(textOf(dataSet, 0x0008_002a)).toBe(`${studyDa}${studyTm}`)
        // An overlay date, a last menstrual date and an age, each from the source's calendar.
        for (const droppedTag of [0x0008_0024, 0x0010_21d0, 0x0010_1010]) {
          expect(dataSet.elements[parserKeyOf(droppedTag)]).toBeUndefined()
        }
        expect(textOf(dataSet, 0x0028_0303)).toBe('MODIFIED')
      }),
      { numRuns: RUNS }
    )
  })

  test('property: removes every private element, marks the image derived and keeps it de-identified', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const sourceKeys = Object.keys(parseDicom(file).elements)
        for (const tag of PRIVATE_TAGS) expect(sourceKeys).toContain(parserKeyOf(tag))

        const dataSet = parseDicom(reidentified(asOf, file, reidentification))
        const oddGroups = Object.keys(dataSet.elements).filter(
          (key) => Number.parseInt(key.slice(1, 5), 16) % 2 === 1
        )
        expect(oddGroups).toEqual([])
        expect(textOf(dataSet, 0x0008_0008)).toBe('DERIVED\\PRIMARY\\AXIAL')
        expect(textOf(dataSet, 0x0012_0062)).toBe('YES')
        expect(textOf(dataSet, 0x0012_0063)).toBe(
          'DCM:113100/113105\\Synthetic re-identification: patient, dates and UIDs replaced'
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('property: keeps Pixel Data byte for byte, and every element it does not rewrite', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const sourceDataSet = parseDicom(file)
        const dataSet = parseDicom(reidentified(asOf, file, reidentification))
        expect(valueBytesOf(dataSet, 0x7fe0_0010)).toEqual(valueBytesOf(sourceDataSet, 0x7fe0_0010))
        // Pixel module and equipment attributes the renderer never names.
        for (const keptTag of [
          0x0008_0016, 0x0008_0060, 0x0008_0070, 0x0028_0010, 0x0028_0011, 0x0028_0100,
        ]) {
          expect(valueBytesOf(dataSet, keptTag)).toEqual(valueBytesOf(sourceDataSet, keptTag))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: writes a well-formed file — even lengths, a true meta group length, the SOP Instance UID in the meta', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const bytes = reidentified(asOf, file, reidentification)
        const dataSet = parseDicom(bytes)
        expect(dataSet.warnings).toEqual([])
        for (const element of Object.values(dataSet.elements)) expect(element.length % 2).toBe(0)
        const firstDataSetElement = Math.min(
          ...Object.entries(dataSet.elements)
            .filter(([key]) => !key.startsWith('x0002'))
            .map(
              ([, element]) =>
                element.dataOffset -
                (element.vr === 'OB' || element.vr === 'OW' || element.vr === 'SQ' ? 12 : 8)
            )
        )
        expect(dataSet.uint32('x00020000')).toBe(firstDataSetElement - (132 + 12))
        expect(textOf(dataSet, 0x0002_0003)).toBe(textOf(dataSet, 0x0008_0018))
        // Text pads to even length with a space, a UID with a null (PS3.5 6.2).
        const patientIdBytes = valueBytesOf(dataSet, 0x0010_0020) ?? new Uint8Array()
        if (reidentification.patientId.length % 2 === 1) expect(patientIdBytes.at(-1)).toBe(0x20)
        const sopInstanceUid = textOf(dataSet, 0x0008_0018) ?? ''
        if (sopInstanceUid.length % 2 === 1) {
          expect(valueBytesOf(dataSet, 0x0008_0018)?.at(-1)).toBe(0x00)
        }
        expect(bytes.slice(0, 128).every((byte) => byte === 0)).toBe(true)
        expect(detectDicom(bytes, 'image.bin')).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: re-mints other instance UIDs from the source value, the same one for the same source UID', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const frameOfReference =
          textOf(parseDicom(reidentified(asOf, file, reidentification)), 0x0020_0052) ?? ''
        expect(frameOfReference).not.toBe(SOURCE_FRAME_OF_REFERENCE_UID)
        expect(isValidUid(frameOfReference)).toBe(true)
        expect(frameOfReference.startsWith(`${DicomImage.UID_ROOT}.`)).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: is byte-identical for any two instants on the same as-of day', () => {
    fc.assert(
      fc.property(
        caseArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        ({ asOf, file, reidentification }, millis) => {
          const sameDay = DateTime.add(DateTime.startOf(asOf, 'day'), { millis })
          expect(reidentified(sameDay, file, reidentification)).toEqual(
            reidentified(asOf, file, reidentification)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: moving the as-of date moves the study date with it and leaves the UIDs and time alone', () => {
    fc.assert(
      fc.property(
        caseArbitrary,
        fc.integer({ min: 1, max: 3650 }),
        ({ asOf, file, reidentification }, days) => {
          const later = DateTime.add(asOf, { days })
          const before = headerOf(reidentified(asOf, file, reidentification))
          const after = headerOf(reidentified(later, file, reidentification))
          const shifted = DateTime.distance(
            dateOfDa(before.studyDate ?? ''),
            dateOfDa(after.studyDate ?? '')
          )
          expect(shifted).toBe(days * 86_400_000)
          expect(after.studyTime).toBe(before.studyTime)
          expect([after.studyInstanceUid, after.seriesInstanceUid, after.sopInstanceUid]).toEqual([
            before.studyInstanceUid,
            before.seriesInstanceUid,
            before.sopInstanceUid,
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: two images of one person, or one image of two people, get different UIDs', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ asOf, file, reidentification }) => {
        const uidsOf = (other: DicomImage.Reidentification): readonly string[] => {
          const header = headerOf(reidentified(asOf, file, other))
          return [header.studyInstanceUid, header.seriesInstanceUid, header.sopInstanceUid]
        }
        const original = uidsOf(reidentification)
        const otherImage = uidsOf({
          ...reidentification,
          imageKey: `${reidentification.imageKey}-2`,
        })
        const otherPerson = uidsOf({
          ...reidentification,
          person: { ...reidentification.person, key: 'person-2' },
        })
        for (const uid of original) {
          expect(otherImage).not.toContain(uid)
          expect(otherPerson).not.toContain(uid)
        }
      }),
      { numRuns: RUNS }
    )
  })

  const plainFile = writeDicom({
    StudyInstanceUID: '1.2.3',
    SeriesInstanceUID: '1.2.3.1',
    SOPInstanceUID: '1.2.3.1.1',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.1.1',
    Modality: 'DX',
    PatientID: 'REAL-PATIENT',
    PixelData: { kind: 'native', byteLength: 16 },
  })

  const person: Person.Person = {
    key: 'person-1',
    givenName: 'Sam',
    familyName: 'Okoye',
    gender: 'male',
    age: 70,
    daysSinceBirthday: 12,
    email: 'sam.okoye@example.com',
    postalCode: 'M5V 1A1',
  }
  const asOf = DateTime.unsafeMake('2026-03-01T00:00:00Z')
  const example: DicomImage.Reidentification = {
    person,
    patientId: 'MRN-1',
    studyDay: -30,
    accessionNumber: undefined,
    imageKey: 'chest-x-ray',
  }

  const failureOf = (
    file: Uint8Array,
    reidentification: DicomImage.Reidentification
  ): Part10.UnsupportedDicomFile | DicomImage.UnencodableValue =>
    Either.flip(DicomImage.reidentify(asOf, file, reidentification)).pipe(Either.getOrThrow)

  test('refuses a file not marked de-identified', () => {
    const failure = failureOf(plainFile, example)
    expect(failure._tag).toBe('UnsupportedDicomFile')
    expect(failure.reason).toBe(
      'PatientIdentityRemoved (0012,0062) is not YES; only a de-identified file is re-identified.'
    )
  })

  test('refuses a name its PN value cannot carry portably, and an accession number longer than SH', () => {
    const deidentified = withElementsSpliced(plainFile, DEIDENTIFIED_EXPORT_ELEMENTS)
    const accented = failureOf(deidentified, {
      ...example,
      person: { ...person, givenName: 'Zoë' },
    })
    expect(accented._tag).toBe('UnencodableValue')
    expect(accented.reason).toBe(
      '(0010,0010) PN cannot hold "Okoye^Zoë": at most 64 printable ASCII characters, no backslash.'
    )
    const longAccession = failureOf(deidentified, {
      ...example,
      accessionNumber: '12345678901234567',
    })
    expect(longAccession._tag).toBe('UnencodableValue')
  })

  test('writes only the synthetic method when the source states an empty DeidentificationMethod', () => {
    const emptyMethod = withElementsSpliced(
      plainFile,
      DEIDENTIFIED_EXPORT_ELEMENTS.map((element) =>
        element.tag === 0x0012_0063 ? { ...element, value: '' } : element
      )
    )
    const dataSet = parseDicom(reidentified(asOf, emptyMethod, example))
    expect(textOf(dataSet, 0x0012_0063)).toBe(
      'Synthetic re-identification: patient, dates and UIDs replaced'
    )
  })
})

describe('DicomImage.importWithSubject', () => {
  const resourcesOf = (
    resources: readonly FhirResource[],
    resourceType: FhirResource['resourceType']
  ): readonly FhirResource[] =>
    resources.filter((resource) => resource.resourceType === resourceType)

  test(
    'property: the importer reads the file onto the given Patient, and makes no Patient of its own',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async ({ asOf, file, reidentification }) => {
          const bytes = reidentified(asOf, file, reidentification)
          expect(dicomImporter.detect(bytes, 'image.dcm')).toBe(true)
          const header = headerOf(bytes)
          const resources = await Effect.runPromise(
            DicomImage.importWithSubject(bytes, 'image.dcm', PHARMACY_PATIENT)
          )

          expect(resourcesOf(resources, 'Patient')).toEqual([])
          const [study, ...otherStudies] = resourcesOf(resources, 'ImagingStudy')
          expect(otherStudies).toEqual([])
          const [sourceFile, ...otherSourceFiles] = resourcesOf(resources, 'DocumentReference')
          expect(otherSourceFiles).toEqual([])
          const serviceRequests = resourcesOf(resources, 'ServiceRequest')
          expect(serviceRequests).toHaveLength(
            reidentification.accessionNumber === undefined ? 0 : 1
          )
          for (const resource of [study, sourceFile, ...serviceRequests]) {
            expect('subject' in resource ? resource.subject : undefined).toEqual(PHARMACY_PATIENT)
          }

          if (study?.resourceType !== 'ImagingStudy') throw new Error('expected an ImagingStudy')
          expect(study.identifier.map((identifier) => identifier.value)).toContain(
            `urn:oid:${header.studyInstanceUid}`
          )
          // The day the importer's instant falls on, on the equipment's clock.
          const startedDay = new Intl.DateTimeFormat('en-CA', {
            timeZone: DicomImage.EQUIPMENT_TIME_ZONE,
          }).format(new Date(String(study.started)))
          expect(startedDay.replaceAll('-', '')).toBe(expectedDaOf(asOf, reidentification.studyDay))

          if (sourceFile?.resourceType !== 'DocumentReference')
            throw new Error('expected a source file')
          const data = sourceFile.content[0]?.attachment?.data
          expect(Buffer.from(String(data), 'base64')).toEqual(Buffer.from(bytes))
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )
})

import {
  type DicomTagMap,
  withElementsSpliced,
  writeDicom,
} from '@wildflowerhealthio/dicom/test-helpers'
import type { PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { layoutDocument } from '@wildflowerhealthio/lifelabs-pdf-importer/test-helpers'
import { Document } from '@wildflowerhealthio/positioned-text'
import { DateTime, Effect, Schema } from 'effect'

import { DicomImage } from '@wildflowerhealthio/synthetic-data-dicom'
import { DEIDENTIFIED_EXPORT_ELEMENTS } from '@wildflowerhealthio/synthetic-data-dicom/test-helpers'
import type { Story } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import { LifeLabs } from '@wildflowerhealthio/synthetic-data-lifelabs'
import {
  type LabRequisition,
  type Laboratory,
  PrintedRange,
} from '@wildflowerhealthio/synthetic-data-lifelabs/story'
import { type RexallAccount, RexallHar } from '@wildflowerhealthio/synthetic-data-rexall-be-well'
import {
  type ShoppersAccount,
  ShoppersHar,
} from '@wildflowerhealthio/synthetic-data-shoppers-drugmart'

import { textPick } from './fixture-picks.ts'

/**
 * The import golden pin's generated picks: one hand-written person — two
 * prescriptions, a dose change, three lab draws — run through each
 * generator at a fixed as-of. Nothing is drawn from a fast-check arbitrary,
 * so a change to one never moves a golden.
 *
 * A picked LifeLabs "PDF" is {@link PDF_HEADER} and then the positioned text
 * it prints, as JSON, which {@link printedDocumentOf} reads back: the test
 * stands it in for `positioned-text-web`'s pdfjs extraction, so the LifeLabs
 * import runs as registered from the extracted text on.
 *
 * @packageDocumentation
 */

/** The as-of every generated file is dated from, and the clock the import runs at. */
const AS_OF = DateTime.unsafeMake('2026-10-31T00:00:00Z')

/** A month after {@link AS_OF}: the same account exported again. */
const LATER_AS_OF = DateTime.unsafeMake('2026-11-30T00:00:00Z')

const PERSON: Story.Story['person'] = {
  key: 'person-1',
  givenName: 'Avery',
  familyName: 'Okafor',
  gender: 'female',
  age: 52,
  daysSinceBirthday: 40,
  email: 'avery.okafor.person-1@example.com',
  postalCode: 'K7L 2V4',
}

const PRESCRIBER = { key: 'prescriber-1', display: 'Dr. Lee Nguyen' }

const LUMIPRIL = {
  brandName: 'Teva-Lumipril',
  genericName: 'Lumipril',
  form: 'tablet',
  company: 'Teva Canada Limited',
} as const

const MORNING_DOSE = { tabletsPerDose: 1, dosesPerDay: 1, direction: 'IN THE MORNING' } as const

/** A statin on a 90-day cadence, and another tablet's dose change. */
const STORY: Story.Story = {
  person: PERSON,
  prescriptions: [
    {
      key: 'person-1-drug1-1',
      product: {
        din: '02345678',
        drugCode: 54321,
        brandName: 'Apo-Alvastatin',
        genericName: 'Alvastatin',
        strength: { value: 20, unit: 'mg' },
        form: 'tablet',
        company: 'Apotex Inc',
      },
      dosing: { tabletsPerDose: 1, dosesPerDay: 1, direction: null },
      supplyDaysPerFill: 90,
      repeatsAllowed: 3,
      prescriber: PRESCRIBER,
      written: { day: -300, reason: 'start' },
      ended: null,
      fillDays: [-299, -208, -117, -26],
    },
    {
      key: 'person-1-drug2-1',
      product: {
        ...LUMIPRIL,
        din: '00456789',
        drugCode: 12345,
        strength: { value: 5, unit: 'mg' },
      },
      dosing: MORNING_DOSE,
      supplyDaysPerFill: 30,
      repeatsAllowed: 5,
      prescriber: PRESCRIBER,
      written: { day: -200, reason: 'start' },
      ended: { day: -140, reason: 'dose-change' },
      fillDays: [-199, -168],
    },
    {
      key: 'person-1-drug2-2',
      product: {
        ...LUMIPRIL,
        din: '00456790',
        drugCode: 12346,
        strength: { value: 10, unit: 'mg' },
      },
      dosing: MORNING_DOSE,
      supplyDaysPerFill: 30,
      repeatsAllowed: 5,
      prescriber: PRESCRIBER,
      written: { day: -140, reason: 'dose-change' },
      ended: null,
      fillDays: [-139, -108, -77, -46, -15],
    },
  ],
  labDraws: [
    { day: -60, test: 'sodium', value: 139, unit: 'mmol/L' },
    { day: -60, test: 'potassium', value: 5.4, unit: 'mmol/L' },
    { day: -10, test: 'alt', value: 22, unit: 'U/L' },
  ],
}

const LABORATORY: Laboratory.Laboratory = {
  addressLines: ['1 Example Blvd.', 'Toronto, Ontario', 'Canada M0M 0M0'],
  licence: '#5687',
  timeZone: 'America/Toronto',
  tests: [
    {
      storyTest: 'sodium',
      name: 'Sodium',
      section: 'Chemistry',
      group: 'Electrolytes',
      decimals: 0,
      range: PrintedRange.eitherSex(PrintedRange.between('135', '145')),
      comments: [],
    },
    {
      storyTest: 'potassium',
      name: 'Potassium',
      section: 'Chemistry',
      group: 'Electrolytes',
      decimals: 1,
      range: PrintedRange.eitherSex(PrintedRange.between('3.5', '5.0')),
      comments: ['Verified by repeat analysis.'],
    },
    {
      storyTest: 'alt',
      name: 'ALT',
      section: 'Chemistry',
      group: 'Liver Function',
      decimals: 0,
      range: PrintedRange.eitherSex(PrintedRange.below('41')),
      comments: [],
    },
  ],
}

const REQUISITION: LabRequisition.LabRequisition = {
  orderedBy: 'ROY DR. ANNE',
  copyTo: ['OSEI DR. KWAME'],
}

const REXALL_ACCOUNT: RexallAccount = {
  uid: '6f1c2a54-3b8e-4d71-9a0c-5e2f7b9d1c43',
  reportingGuid: '0d9e8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b',
  storeId: '4821',
  pharmacyLocationId: 'pharmacy-4821',
  createdDay: -2000,
  updatedDay: -400,
}

const SHOPPERS_ACCOUNT: ShoppersAccount = {
  pcid: '3c7e9a1b-5d2f-4b8a-9e6c-0f1d2a3b4c5d',
  phoneNumber: '6135550101',
  address: { line1: '12 Main St', city: 'Kingston', province: 'ON', postalCode: 'K7L 2V4' },
  store: {
    id: 1234,
    storeName: 'Shoppers Drug Mart #1234',
    phoneNumber: '6135550102',
    address: { line1: '112 King St', city: 'Kingston', province: 'ON', postalCode: 'K7L 1B3' },
  },
  patients: [
    { patientId: '8b2d4f6a-1c3e-4a5b-8d7f-9e0a1b2c3d4e', phoneNumber: '6135550103', story: STORY },
  ],
}

/** A de-identified chest film's tags, before the export's own elements are spliced in. */
const DEIDENTIFIED_TAGS: DicomTagMap = {
  PatientName: { family: 'ANONYMIZED', given: '', text: 'ANONYMIZED' },
  PatientID: 'ANON-0001',
  StudyInstanceUID: '1.2.826.0.1.3680043.8.498.10',
  StudyDate: '20000101',
  StudyDescription: 'CHEST PA',
  SeriesInstanceUID: '1.2.826.0.1.3680043.8.498.10.1',
  SeriesNumber: 1,
  Modality: 'CR',
  BodyPartExamined: 'CHEST',
  SOPInstanceUID: '1.2.826.0.1.3680043.8.498.10.1.1',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.1',
  InstanceNumber: 1,
  TransferSyntaxUID: '1.2.840.10008.1.2.1',
  Rows: 2,
  Columns: 2,
  SamplesPerPixel: 1,
  PhotometricInterpretation: 'MONOCHROME2',
  BitsAllocated: 8,
  BitsStored: 8,
  HighBit: 7,
  PixelRepresentation: 0,
  PixelData: { kind: 'native', byteLength: 4 },
}

/** The person's Rexall Be Well session, exported at `asOf` as `fileName`. */
const rexallPick = (fileName: string, asOf: DateTime.Utc): Effect.Effect<PickedFile.NamedBytes> =>
  Effect.map(Effect.orDie(RexallHar.render(asOf, STORY, REXALL_ACCOUNT)), (text) =>
    textPick(fileName, text)
  )

/** The person's Shoppers Drug Mart session. */
const shoppersPick = (): Effect.Effect<PickedFile.NamedBytes> =>
  Effect.map(Effect.orDie(ShoppersHar.render(AS_OF, SHOPPERS_ACCOUNT)), (text) =>
    textPick('shoppers.har', text)
  )

/** What a picked LifeLabs "PDF" starts with, ahead of the positioned text it prints. */
const PDF_HEADER = '%PDF-1.7\n'

/** The person's LifeLabs report PDF: the reports of their lab draws, printed. */
const lifeLabsPick = (): Effect.Effect<PickedFile.NamedBytes> =>
  Effect.map(Effect.orDie(LifeLabs.reportsOf(AS_OF, STORY, LABORATORY, REQUISITION)), (reports) =>
    textPick('lifelabs-report.pdf', `${PDF_HEADER}${JSON.stringify(layoutDocument(reports))}`)
  )

/** The positioned text a picked LifeLabs "PDF" ({@link lifeLabsPick}) prints. */
const printedDocumentOf = (bytes: Uint8Array): Document.Type =>
  Schema.decodeUnknownSync(Document.FromJson)(
    new TextDecoder().decode(bytes).slice(PDF_HEADER.length)
  )

/** The chest film re-identified as the person, taken a year before the as-of. */
const dicomPick = (): Effect.Effect<PickedFile.NamedBytes> =>
  Effect.map(
    Effect.orDie(
      DicomImage.reidentify(
        AS_OF,
        withElementsSpliced(writeDicom(DEIDENTIFIED_TAGS), DEIDENTIFIED_EXPORT_ELEMENTS),
        {
          person: PERSON,
          patientId: 'MRN1',
          studyDay: -365,
          accessionNumber: 'ACC1',
          imageKey: 'chest-x-ray',
        }
      )
    ),
    (bytes): PickedFile.NamedBytes => ({ fileName: 'chest-x-ray.dcm', bytes })
  )

export { AS_OF, dicomPick, LATER_AS_OF, lifeLabsPick, printedDocumentOf, rexallPick, shoppersPick }

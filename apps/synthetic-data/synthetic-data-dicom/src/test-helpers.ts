/**
 * De-identified DICOM fixtures for the DICOM generator's tests, shared through
 * the `synthetic-data-dicom/test-helpers` subpath: a `dicom/test-helpers`
 * `writeDicom` file with the elements a de-identified export carries and
 * `writeDicom` cannot write — private groups, the de-identification
 * attributes, extra dates, a Frame of Reference — spliced in at their place in
 * tag order (`withElementsSpliced`, located with `dicom-parser` rather than
 * the `Part10` reader the generator uses).
 *
 * @packageDocumentation
 */
import {
  type DicomTagMap,
  dicomHeaderArb,
  type ExtraElement,
  headerToTagMap,
  withElementsSpliced,
  writeDicom,
} from '@wildflowerhealthio/dicom/test-helpers'
import * as fc from 'fast-check'

const SOURCE_FRAME_OF_REFERENCE_UID = '1.3.6.1.4.1.14519.5.2.1.99.2'

/**
 * What a de-identified export adds to a `writeDicom` file: private groups
 * `0009` and `0013`, the de-identification attributes, an `ImageType`, dates
 * no re-identification writes (an overlay date, a last menstrual date), an
 * `AcquisitionDateTime`, a `PatientAge` and a Frame of Reference UID.
 */
const DEIDENTIFIED_EXPORT_ELEMENTS: readonly ExtraElement[] = [
  { tag: 0x0008_0008, vr: 'CS', value: 'ORIGINAL\\PRIMARY\\AXIAL' },
  { tag: 0x0008_0024, vr: 'DA', value: '20000101' },
  { tag: 0x0008_002a, vr: 'DT', value: '20000101' },
  { tag: 0x0009_0010, vr: 'LO', value: 'ACME PRIVATE' },
  { tag: 0x0009_1001, vr: 'LO', value: 'site-internal-id-4471' },
  { tag: 0x0010_1010, vr: 'AS', value: '061Y' },
  { tag: 0x0010_21d0, vr: 'DA', value: '20000101' },
  { tag: 0x0012_0062, vr: 'CS', value: 'YES' },
  { tag: 0x0012_0063, vr: 'LO', value: 'DCM:113100/113105' },
  { tag: 0x0013_0010, vr: 'LO', value: 'CTP' },
  { tag: 0x0013_1010, vr: 'LO', value: 'COLLECTION-0002' },
  { tag: 0x0020_0052, vr: 'UI', value: SOURCE_FRAME_OF_REFERENCE_UID },
]

/** The private elements {@link DEIDENTIFIED_EXPORT_ELEMENTS} adds. */
const PRIVATE_TAGS = DEIDENTIFIED_EXPORT_ELEMENTS.map((element) => element.tag).filter(
  (tag) => (tag >>> 16) % 2 === 1
)

/**
 * A de-identified source file's tags: a generated header, as Explicit VR
 * Little Endian, always with native Pixel Data.
 */
const deidentifiedTagsArbitrary: fc.Arbitrary<DicomTagMap> = fc
  .tuple(dicomHeaderArb(), fc.integer({ min: 2, max: 4096 }))
  .map(([header, pixelBytes]) => ({
    ...headerToTagMap(header),
    TransferSyntaxUID: '1.2.840.10008.1.2.1',
    PixelData: { kind: 'native', byteLength: pixelBytes + (pixelBytes % 2) },
  }))

/** A de-identified source file: {@link deidentifiedTagsArbitrary} with the export's own elements. */
const deidentifiedFileArbitrary: fc.Arbitrary<Uint8Array> = deidentifiedTagsArbitrary.map((tags) =>
  withElementsSpliced(writeDicom(tags), DEIDENTIFIED_EXPORT_ELEMENTS)
)

export {
  DEIDENTIFIED_EXPORT_ELEMENTS,
  deidentifiedFileArbitrary,
  deidentifiedTagsArbitrary,
  PRIVATE_TAGS,
  SOURCE_FRAME_OF_REFERENCE_UID,
}

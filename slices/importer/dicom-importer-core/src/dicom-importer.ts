import { DecodeFunction, type FileImporter } from 'importer-fundamentals'

import { linkToPatientAndStudy, decodeStudy, studyGroupKey } from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

const format = 'dicom'

const display = {
  title: 'DICOM image',
  description: 'Import a DICOM (.dcm) study — pick every file of it, or its folder.',
}
const sourceFileFormat = {
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: 'application/dicom',
  descriptionPrefix: `${display.title}: `,
}

/**
 * The DICOM importer: a pick of `.dcm` files in, one `ImagingStudy` per study
 * out.
 *
 * @remarks
 * The one format so far that states a `groupBy`: a study's files are not
 * independent — each states one instance of a study whose counts, modality set
 * and earliest `started` only the whole set knows. Its source files link to what
 * the study decoded to, because a DICOM file is a clinical document and
 * belongs in its patient's record.
 */
const dicomImporter: FileImporter.Type<DicomSettings, typeof format> = {
  format,
  display,
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  sourceFileFormat,
  decode: DecodeFunction.make({
    format,
    sourceFileFormat,
    groupBy: studyGroupKey,
    decodeFileSet: decodeStudy,
    linkSourceFile: linkToPatientAndStudy,
  }),
}

export { dicomImporter }

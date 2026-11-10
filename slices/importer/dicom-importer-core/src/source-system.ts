/**
 * The source system every resource this binding imports is keyed under — a
 * Wildflower-minted `sid` URI naming DICOM. **Persisted wire format:** the
 * hash domain for every derived local id and the `Identifier.system` beside
 * every source id, so changing it orphans everything already imported. Its
 * own leaf module so the importer, the source file codec, and any future FHIR
 * synthesis import it without a cycle.
 */
const DICOM_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/dicom'

/**
 * The system a referring physician a header names only by
 * `ReferringPhysicianName` is keyed in: the name in natural order, trimmed
 * and its whitespace collapsed (`fhir-r4`'s `Practitioner.nameIdentifier`).
 * **Persisted wire format**, as {@link DICOM_SYSTEM} is.
 */
const DICOM_PRACTITIONER_NAME_SYSTEM = `${DICOM_SYSTEM}/practitioner-name`

const DICOM_SOURCE_FILE_CODE = 'dicom-source-file'

const DICOM_SOURCE_FILE_CONTENT_TYPE = 'application/dicom'

export {
  DICOM_PRACTITIONER_NAME_SYSTEM,
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
}

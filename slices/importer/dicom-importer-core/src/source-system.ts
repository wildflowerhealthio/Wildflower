/**
 * The source system every resource this binding imports is keyed under — a
 * Wildflower-minted `sid` URI naming DICOM. **Persisted wire format:** the
 * hash domain for every derived local id and the `Identifier.system` beside
 * every source id, so changing it orphans everything already imported. Its
 * own leaf module so the importer, the source file codec, and any future FHIR
 * synthesis import it without a cycle.
 */
const DICOM_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/dicom'

const DICOM_SOURCE_FILE_CODE = 'dicom-source-file'

const DICOM_SOURCE_FILE_CONTENT_TYPE = 'application/dicom'

export { DICOM_SOURCE_FILE_CODE, DICOM_SOURCE_FILE_CONTENT_TYPE, DICOM_SYSTEM }

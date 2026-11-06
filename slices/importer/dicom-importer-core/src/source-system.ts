/**
 * The coding system an imported DICOM file's source file is stored under — a
 * Wildflower-minted `sid` URI naming DICOM. **Persisted wire format:** the
 * system of every DICOM source file's `type` and `category` coding, which the
 * server-side source-file search matches, so changing it hides every DICOM
 * source file already stored, and the stem of
 * {@link DICOM_PRACTITIONER_NAME_SYSTEM}. Its own leaf module so the importer,
 * the source file codec, and the FHIR synthesis import it without a cycle.
 */
const DICOM_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/dicom'

/**
 * The system a referring physician a header names only by
 * `ReferringPhysicianName` is keyed in: the name in natural order, trimmed
 * and its whitespace collapsed (`fhir-r4`'s `Practitioner.nameIdentifier`).
 * **Persisted wire format**, as {@link DICOM_SYSTEM} is.
 */
const DICOM_PRACTITIONER_NAME_SYSTEM = `${DICOM_SYSTEM}/practitioner-name`

/**
 * The identifier systems the synthesis keys its records in: the Study
 * Instance UID in FHIR's own system for it, and, for a Patient ID or an
 * Accession Number whose issuer the file does not state as a URI, a
 * Wildflower-minted system meaning just that.
 *
 * @remarks
 * **Persisted wire format.** A record's key, `identifier[0]`, is in one of
 * these or in the URI its issuer names (`issuer.ts`), and the id it is stored
 * under derives from it, so changing a system or the value written in it
 * re-keys every DICOM record of that type already imported. The minted
 * systems are not a registry: each says only "a DICOM number of this kind",
 * so a study re-imported from a second disc lands on the same records.
 */
const DicomIdentifierSystem = {
  /**
   * A Patient ID (0010,0020) whose file states no universal issuer for it:
   * Wildflower-minted. A local Issuer of Patient ID (0010,0021) is the
   * identifier's `assigner.display`, not part of its system.
   */
  PatientId: 'https://wildflowerhealth.io/fhir/sid/dicom/patient-id',
  /**
   * A patient the file names only by Patient Name and birth date,
   * `<name>, <YYYY-MM-DD>` (the name alone when the file states no valid
   * birth date): Wildflower-minted.
   */
  PatientNameBirthDate: 'https://wildflowerhealth.io/fhir/sid/dicom/patient-name-birth-date',
  /**
   * An Accession Number (0008,0050) whose file states no universal issuer for
   * it: Wildflower-minted.
   */
  AccessionNumber: 'https://wildflowerhealth.io/fhir/sid/dicom/accession-number',
  /**
   * A Study Instance UID (0020,000D), written `urn:oid:<uid>`: FHIR R4's
   * system for a DICOM UID (Identifier, R4 datatypes).
   */
  StudyInstanceUid: 'urn:dicom:uid',
} as const

const DICOM_SOURCE_FILE_CODE = 'dicom-source-file'

const DICOM_SOURCE_FILE_CONTENT_TYPE = 'application/dicom'

export {
  DICOM_PRACTITIONER_NAME_SYSTEM,
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
  DicomIdentifierSystem,
}

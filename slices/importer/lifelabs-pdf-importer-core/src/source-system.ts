/**
 * The coding system an uploaded LifeLabs report PDF's source file is stored
 * under — a Wildflower-minted `sid` URI naming LifeLabs. **Persisted wire
 * format:** the system of every LifeLabs source file's `type` and `category`
 * coding, which the server-side source-file search matches, so changing it
 * hides every LifeLabs source file already stored. Its own leaf module so the
 * importer and the FHIR synthesis import it without a cycle.
 */
const LIFELABS_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/lifelabs'

/**
 * The identifier systems the synthesis keys its records in and writes beside
 * them: the numbers the report prints, and, for a record the report prints no
 * number for, a Wildflower-minted system over what it does print.
 *
 * @remarks
 * **Persisted wire format.** A record's key, `identifier[0]`, is one of
 * these, and the id it is stored under derives from it, so changing a system
 * or the value written in it re-keys every LifeLabs record of that type
 * already imported.
 */
const LifeLabsIdentifierSystem = {
  /** The report's `Lab No` (`2024-JJ6330780`), in a Wildflower-minted system. */
  LabNumber: 'https://wildflowerhealth.io/fhir/sid/lifelabs/lab-number',
  /** The report's `Patient ID`, when it prints one, in a Wildflower-minted system. */
  PatientId: 'https://wildflowerhealth.io/fhir/sid/lifelabs/patient-id',
  /**
   * The Ontario health card number the report prints as `HC #` — Canada
   * Health Infoway's naming system for it.
   */
  OntarioHealthCardNumber: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-on-patient-hcn',
  /**
   * A patient by the name and date of birth the report prints,
   * `<name>, <date of birth>`: Wildflower-minted, for a report that prints
   * neither number.
   */
  PatientNameBirthDate: 'https://wildflowerhealth.io/fhir/sid/lifelabs/patient-name-birth-date',
  /**
   * An Observation, one per printed result row,
   * `<Lab No>/<section>/<test name>/<ordinal>`: Wildflower-minted.
   */
  Observation: 'https://wildflowerhealth.io/fhir/sid/lifelabs/observation',
  /**
   * A provider by the name the report prints, inner whitespace collapsed:
   * Wildflower-minted.
   */
  PractitionerName: 'https://wildflowerhealth.io/fhir/sid/lifelabs/practitioner-name',
} as const

const LIFELABS_PDF_SOURCE_FILE_CODE = 'lifelabs-pdf-archive'

const LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE = 'application/pdf'

export {
  LIFELABS_PDF_SOURCE_FILE_CODE,
  LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE,
  LIFELABS_SYSTEM,
  LifeLabsIdentifierSystem,
}

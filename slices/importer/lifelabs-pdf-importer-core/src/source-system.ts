/**
 * The source system every resource this binding imports is keyed under — a
 * Wildflower-minted `sid` URI naming LifeLabs. **Persisted wire format:** the
 * hash domain for every derived local id and the `Identifier.system` beside
 * every source id, so changing it orphans everything already imported. Its
 * own leaf module so the descriptor, the response kind and the FHIR synthesis
 * import it without a cycle.
 */
const LIFELABS_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/lifelabs'

/**
 * The identifier systems the synthesis writes beside the report's own
 * numbers, so a reader can tell a lab number from a health card number.
 */
const LifeLabsIdentifierSystem = {
  /** The report's `Lab No` (`2024-JJ6330780`). */
  LabNumber: 'https://wildflowerhealth.io/fhir/sid/lifelabs/lab-number',
  /** The report's `Patient ID`, when it prints one. */
  PatientId: 'https://wildflowerhealth.io/fhir/sid/lifelabs/patient-id',
  /**
   * The Ontario health card number the report prints as `HC #` — Canada
   * Health Infoway's naming system for it.
   */
  OntarioHealthCardNumber: 'https://fhir.infoway-inforoute.ca/NamingSystem/ca-on-patient-hcn',
} as const

export { LIFELABS_SYSTEM, LifeLabsIdentifierSystem }

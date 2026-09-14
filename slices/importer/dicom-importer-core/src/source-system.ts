/**
 * The source system every resource this binding imports is keyed under — a
 * Wildflower-minted `sid` URI naming DICOM. **Persisted wire format:** the
 * hash domain for every derived local id and the `Identifier.system` beside
 * every source id, so changing it orphans everything already imported. Its
 * own leaf module so the descriptor, the source file codec, and any future FHIR
 * synthesis import it without a cycle.
 */
const DICOM_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/dicom'

export { DICOM_SYSTEM }

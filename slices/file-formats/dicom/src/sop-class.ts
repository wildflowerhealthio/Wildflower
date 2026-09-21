/**
 * SOP Class UIDs: what kind of object a file is, and the name to show for one.
 *
 * @remarks
 * A display label derived from a UID, not a parsed tag — which is why it sits
 * beside `DicomHeader` rather than in it. The table is not exhaustive; an
 * unknown UID reads as `undefined` so a caller shows the raw value rather than
 * a wrong name.
 *
 * @packageDocumentation
 */

/**
 * The storage SOP classes worth naming. A class that is not an image class —
 * Structured Report, Presentation State, Encapsulated PDF — is the common
 * reason a file parses perfectly and still has nothing to display.
 */
const NAMES: Readonly<Record<string, string>> = {
  '1.2.840.10008.5.1.4.1.1.1': 'Computed Radiography Image Storage',
  '1.2.840.10008.5.1.4.1.1.1.1': 'Digital X-Ray Image Storage — For Presentation',
  '1.2.840.10008.5.1.4.1.1.1.1.1': 'Digital X-Ray Image Storage — For Processing',
  '1.2.840.10008.5.1.4.1.1.1.2': 'Digital Mammography X-Ray Image Storage — For Presentation',
  '1.2.840.10008.5.1.4.1.1.1.2.1': 'Digital Mammography X-Ray Image Storage — For Processing',
  '1.2.840.10008.5.1.4.1.1.2': 'CT Image Storage',
  '1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT Image Storage',
  '1.2.840.10008.5.1.4.1.1.3.1': 'Ultrasound Multi-frame Image Storage',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.6.1': 'Ultrasound Image Storage',
  '1.2.840.10008.5.1.4.1.1.7': 'Secondary Capture Image Storage',
  '1.2.840.10008.5.1.4.1.1.11.1': 'Grayscale Softcopy Presentation State Storage',
  '1.2.840.10008.5.1.4.1.1.12.1': 'X-Ray Angiographic Image Storage',
  '1.2.840.10008.5.1.4.1.1.12.2': 'X-Ray Radiofluoroscopic Image Storage',
  '1.2.840.10008.5.1.4.1.1.20': 'Nuclear Medicine Image Storage',
  '1.2.840.10008.5.1.4.1.1.66': 'Raw Data Storage',
  '1.2.840.10008.5.1.4.1.1.77.1.6': 'VL Whole Slide Microscopy Image Storage',
  '1.2.840.10008.5.1.4.1.1.88.11': 'Basic Text SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.22': 'Enhanced SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.33': 'Comprehensive SR Storage',
  '1.2.840.10008.5.1.4.1.1.104.1': 'Encapsulated PDF Storage',
  '1.2.840.10008.5.1.4.1.1.128': 'Positron Emission Tomography Image Storage',
  '1.2.840.10008.5.1.4.1.1.481.1': 'RT Image Storage',
}

/** The display name for a SOP Class UID, or `undefined` if unrecognized. */
const name = (uid: string): string | undefined =>
  Object.hasOwn(NAMES, uid) ? NAMES[uid] : undefined

export { name }

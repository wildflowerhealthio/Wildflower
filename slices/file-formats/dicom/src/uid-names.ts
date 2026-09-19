/**
 * Human-readable names for the DICOM UIDs a decode-debug view shows: transfer
 * syntaxes and SOP classes.
 *
 * @remarks
 * Display labels derived from a UID, not parsed tags — which is why they sit
 * beside {@link DicomHeader} rather than in it. Neither table is exhaustive;
 * an unknown UID returns `undefined` so a caller shows the raw value rather
 * than a wrong name.
 *
 * @packageDocumentation
 */

/**
 * The transfer syntaxes a browser-side viewer is likely to be handed, with the
 * lossy ones marked — a lossy syntax that renders at all still renders
 * something the source did not contain.
 */
const TRANSFER_SYNTAX_NAMES: Readonly<Record<string, string>> = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian (retired)',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline 8-bit (lossy)',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended 12-bit (lossy)',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless, Non-Hierarchical',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless, First-Order Prediction',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-Lossless (lossy)',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000 (lossy)',
  '1.2.840.10008.1.2.4.92': 'JPEG 2000 Part 2 Multi-Component Lossless',
  '1.2.840.10008.1.2.4.93': 'JPEG 2000 Part 2 Multi-Component (lossy)',
  '1.2.840.10008.1.2.4.100': 'MPEG2 Main Profile / Main Level (lossy)',
  '1.2.840.10008.1.2.4.101': 'MPEG2 Main Profile / High Level (lossy)',
  '1.2.840.10008.1.2.4.102': 'MPEG-4 AVC/H.264 High Profile / Level 4.1 (lossy)',
  '1.2.840.10008.1.2.4.103': 'MPEG-4 AVC/H.264 BD-compatible High Profile (lossy)',
  '1.2.840.10008.1.2.4.107': 'HEVC/H.265 Main Profile / Level 5.1 (lossy)',
  '1.2.840.10008.1.2.4.108': 'HEVC/H.265 Main 10 Profile / Level 5.1 (lossy)',
  '1.2.840.10008.1.2.4.201': 'High-Throughput JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.202': 'High-Throughput JPEG 2000 RPCL Lossless',
  '1.2.840.10008.1.2.4.203': 'High-Throughput JPEG 2000 (lossy)',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
}

/**
 * The storage SOP classes worth naming. A class that is not an image class —
 * Structured Report, Presentation State, Encapsulated PDF — is the common
 * reason a file parses perfectly and still has nothing to display.
 */
const SOP_CLASS_NAMES: Readonly<Record<string, string>> = {
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

/**
 * Look a UID up in a name table.
 *
 * @remarks
 * `Object.hasOwn` rather than a bare index: these tables are object literals,
 * so a bare lookup answers inherited keys — `'constructor'` would come back as
 * a function that a caller would then render as a transfer syntax name. The
 * UID is untrusted input read straight out of a file.
 */
const lookupName = (table: Readonly<Record<string, string>>, uid: string): string | undefined =>
  Object.hasOwn(table, uid) ? table[uid] : undefined

/** The display name for a Transfer Syntax UID, or `undefined` if unrecognized. */
const transferSyntaxName = (uid: string): string | undefined =>
  lookupName(TRANSFER_SYNTAX_NAMES, uid)

/** The display name for a SOP Class UID, or `undefined` if unrecognized. */
const sopClassName = (uid: string): string | undefined => lookupName(SOP_CLASS_NAMES, uid)

export { sopClassName, transferSyntaxName }

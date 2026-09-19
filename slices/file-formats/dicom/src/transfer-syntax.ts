/**
 * Transfer Syntax UIDs: how a file's pixels are encoded, and the name to show
 * for one.
 *
 * @remarks
 * A display label derived from a UID, not a parsed tag — which is why it sits
 * beside `DicomHeader` rather than in it. The table is not exhaustive; an
 * unknown UID reads as `undefined` so a caller shows the raw value rather than
 * a wrong name.
 *
 * @packageDocumentation
 */

import { lookupUidName } from './uid-name-table.ts'

/**
 * The transfer syntaxes a browser-side viewer is likely to be handed, with the
 * lossy ones marked — a lossy syntax that renders at all still renders
 * something the source did not contain.
 */
const NAMES: Readonly<Record<string, string>> = {
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

/** The display name for a Transfer Syntax UID, or `undefined` if unrecognized. */
const name = (uid: string): string | undefined => lookupUidName(NAMES, uid)

export { name }

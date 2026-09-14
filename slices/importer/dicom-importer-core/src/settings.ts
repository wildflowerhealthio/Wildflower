/**
 * The DICOM importer's per-import settings.
 *
 * @remarks
 * The format has no configurable knobs yet — the decode stores the raw bytes as
 * an archive and reads no headers. Future tickets (D3) will add settings as the
 * decode gains the ability to interpret DICOM tags.
 */
type DicomSettings = Record<string, never>

const defaultDicomSettings: DicomSettings = {}

export { defaultDicomSettings }
export type { DicomSettings }

/**
 * Browser-side DICOM rendering: {@link DicomFilePreview}, the shell's preview
 * of one `.dcm` file, over the {@link renderInstance} cornerstone seam.
 *
 * @packageDocumentation
 */
export { DicomFilePreview, type DicomFilePreviewProps } from './file-preview.tsx'
export { observeViewportResize, renderInstance, type RenderOutcome } from './render-instance.ts'

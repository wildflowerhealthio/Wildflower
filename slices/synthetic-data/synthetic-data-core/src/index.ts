/**
 * The synthetic data set assembler: generated records, run through the real
 * importers, as the files a published data set holds — one per resource under
 * `fhir/<ResourceType>/<id>.json`, the files the importers read under `har/`
 * and `dicom/` (`DataSetLayout`), and `index.json` listing each person's
 * files (`DataSetManifest`) — all of it as one list of files to write
 * (`DataSet.assemble`). The reading half (`DataSet.readManifest`,
 * `DataSet.readResource`) reads a file back into the resource the import
 * wrote, and `WriteOrder` orders the resources into the batch bundles a
 * reader writes them to a FHIR server in.
 *
 * Pure: the step that writes the files, and the app that fetches and loads
 * them, are elsewhere.
 *
 * @packageDocumentation
 */
export * as DataSet from './data-set.ts'
export * as DataSetLayout from './data-set-layout.ts'
export * as DataSetManifest from './data-set-manifest.ts'
export * as WriteOrder from './write-order.ts'

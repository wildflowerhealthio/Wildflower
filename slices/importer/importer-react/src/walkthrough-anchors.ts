/**
 * The `data-walkthrough` values of the import screen's first-screen controls,
 * for a host app's first-run walkthrough to point at.
 *
 * @remarks
 * The screen carries them so a host's walkthrough can name its controls
 * without reaching into its markup; the walkthrough itself (its steps, its
 * record, when it shows) is the host's. The uploaded source files' heading
 * carries its value wherever `ServerSourceFileList` is mounted, the
 * anonymizer's `serverSource` slot included.
 */
const ImporterWalkthroughAnchor = {
  /** The drop zone, "Choose files, or drop them here". */
  dropZone: 'drop-zone',
  /** The "Choose a folder" button. */
  chooseFolder: 'choose-folder',
  /** The heading of the uploaded source files on the FHIR server. */
  serverSourceFiles: 'server-source-files',
} as const

export { ImporterWalkthroughAnchor }

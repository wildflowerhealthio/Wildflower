import { useNavigate, useSearch } from '@tanstack/react-router'
import { ImporterWalkthroughAnchor } from '@wildflowerhealthio/importer-react'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'

/** The Importer's walkthrough's id, naming its record in the page's `localStorage`. */
const IMPORTER_WALKTHROUGH_ID = 'importer'

/** The version of {@link IMPORTER_WALKTHROUGH_STEPS}; raising it shows the walkthrough again. */
const IMPORTER_WALKTHROUGH_VERSION = 1

/**
 * The `data-walkthrough` values of the controls the walkthrough points at:
 * the page's own (the tabs and Show walkthrough again), beside the ones
 * `importer-react` puts on the import screen's first screen.
 */
const ImporterPageWalkthroughAnchor = {
  importTab: 'import-tab',
  anonymizeTab: 'anonymize-tab',
  showAgain: 'show-walkthrough-again',
} as const

/**
 * The Importer's walkthrough, in page order, over the Import tab's first
 * screen, the source picker. Once files are picked, the picker gives way to
 * the preview, and only the tabs and Show walkthrough again are left to show.
 */
const IMPORTER_WALKTHROUGH_STEPS: ReadonlyArray<WalkthroughStep> = [
  {
    anchor: ImporterPageWalkthroughAnchor.importTab,
    title: 'Import',
    body: 'Import adds the records in your files to the FHIR server you opened the Importer from.',
  },
  {
    anchor: ImporterWalkthroughAnchor.dropZone,
    title: 'Choose files, or drop them here',
    body: "Pick HAR files saved from a pharmacy's website, such as Shoppers Drug Mart or Rexall Be Well, LifeLabs report PDFs, or DICOM imaging files. You review every record before anything is saved.",
  },
  {
    anchor: ImporterWalkthroughAnchor.chooseFolder,
    title: 'Choose a folder',
    body: 'A DICOM imaging study usually comes as a folder of files. Choose the whole folder here.',
  },
  {
    anchor: ImporterWalkthroughAnchor.serverSourceFiles,
    title: 'Uploaded source files on the FHIR server',
    body: 'Each file you import is kept on the server and listed here. Select files to import them again.',
  },
  {
    anchor: ImporterPageWalkthroughAnchor.anonymizeTab,
    title: 'Anonymize',
    body: 'Anonymize replaces every value in a capture with a pseudonym so its shape can be shared. It saves nothing to the server.',
  },
  {
    anchor: ImporterPageWalkthroughAnchor.showAgain,
    title: 'Show walkthrough again',
    body: 'Select this to see these steps again.',
  },
]

/**
 * The Import tab's search: `walkthrough=show` is the page's Show walkthrough
 * again link, which shows the walkthrough whatever its record says.
 */
const ImportSearch = Schema.Struct({ walkthrough: Schema.optional(Schema.Literal('show')) })
type ImportSearch = typeof ImportSearch.Type

/** The Import tab's search that shows the walkthrough again. */
const SHOW_WALKTHROUGH_AGAIN_SEARCH: ImportSearch = { walkthrough: 'show' }

/**
 * Whether the Import tab shows the Importer's walkthrough, kept in the page's
 * `localStorage`, and how the visitor leaves it.
 *
 * @remarks
 * It shows on a first visit, while no record for
 * {@link IMPORTER_WALKTHROUGH_VERSION} is kept, and whenever the tab's search
 * asks for it. Finishing or skipping records the outcome, and postponing (no
 * step's control on the page) records nothing; each drops that search,
 * replacing the history entry, so Back doesn't show it again.
 */
const useImportWalkthrough = (): Pick<
  WalkthroughPrompt,
  'open' | 'finish' | 'skip' | 'postpone'
> => {
  const prompt = useWalkthrough({
    storage: window.localStorage,
    id: IMPORTER_WALKTHROUGH_ID,
    version: IMPORTER_WALKTHROUGH_VERSION,
  })
  const showAgain = useSearch({ from: '/import', select: (search) => search.walkthrough })
  const navigate = useNavigate()
  const dropShowAgain = (): void => {
    if (showAgain === undefined) return
    void navigate({ to: '/import', search: {}, replace: true })
  }
  return {
    open: prompt.open || showAgain === 'show',
    finish: () => {
      prompt.finish()
      dropShowAgain()
    },
    skip: () => {
      prompt.skip()
      dropShowAgain()
    },
    postpone: () => {
      prompt.postpone()
      dropShowAgain()
    },
  }
}

export {
  IMPORTER_WALKTHROUGH_ID,
  IMPORTER_WALKTHROUGH_STEPS,
  IMPORTER_WALKTHROUGH_VERSION,
  ImporterPageWalkthroughAnchor,
  ImportSearch,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
  useImportWalkthrough,
}

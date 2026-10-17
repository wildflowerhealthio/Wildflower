import type { PickedFile } from '@wildflowerhealthio/anonymizer-fundamentals'
import { ServerSourceFileList } from '@wildflowerhealthio/importer-react'
import type { JSX } from 'react'

/**
 * The anonymizer shell is server-blind; this app has an authed FHIR context,
 * so it passes the importer slice's uploaded-source-files list through the
 * `serverSource` slot. The anonymizer reads one file at a time, so the list is
 * capped at one pick and the one file it yields is handed straight on — the
 * importer's picked file and the anonymizer's both carry
 * `{ fileName, bytes }`, so there is nothing to re-encode.
 */
const ServerSource = ({ onPick }: { readonly onPick: (file: PickedFile) => void }): JSX.Element => (
  <ServerSourceFileList
    maxPicks={1}
    onPick={([picked]) => {
      if (picked !== undefined) onPick({ fileName: picked.fileName, bytes: picked.bytes })
    }}
  />
)

export { ServerSource }

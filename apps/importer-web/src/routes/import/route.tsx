import { createFileRoute } from '@tanstack/react-router'
import { ImporterScreen } from '@wildflowerhealthio/importer-react'
import { Walkthrough } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'
import type { JSX } from 'react'

import {
  IMPORTER_WALKTHROUGH_STEPS,
  ImportSearch,
  useImportWalkthrough,
} from './-import-walkthrough.ts'

/**
 * The Import tab: `importer-react`'s screen, which takes no props and reads
 * its authed runner out of route context (`fhir-r4-react`'s `useRunAuthed`),
 * with the Importer's walkthrough over it.
 *
 * @remarks
 * The walkthrough (`useImportWalkthrough`) points at the screen's source
 * picker on a first visit, and when the page's Show walkthrough again link
 * asks for it. It mounts with the screen: the picker reads nothing before it
 * shows, and the uploaded source files, the one part that waits on a read,
 * are pointed at by their heading, which is there while they load.
 */
function ImportTab(): JSX.Element {
  const walkthrough = useImportWalkthrough()
  return (
    <>
      <ImporterScreen />
      <Walkthrough
        steps={IMPORTER_WALKTHROUGH_STEPS}
        open={walkthrough.open}
        onFinish={walkthrough.finish}
        onSkip={walkthrough.skip}
        onPostpone={walkthrough.postpone}
      />
    </>
  )
}

/** `/import`, the Import tab, whose `?walkthrough=show` shows the Importer's walkthrough again. */
const Route = createFileRoute('/import')({
  staticData: { subtitle: 'Import FHIR records from a captured browsing session.' },
  validateSearch: Schema.standardSchemaV1(ImportSearch),
  component: ImportTab,
})

export { Route }

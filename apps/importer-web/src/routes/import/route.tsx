import { createFileRoute } from '@tanstack/react-router'
import { ImporterScreen } from '@wildflowerhealthio/importer-react'

/**
 * `/import`, the Import tab: `importer-react`'s screen, which takes no props
 * and reads its authed runner out of route context (`fhir-r4-react`'s
 * `useRunAuthed`).
 */
const Route = createFileRoute('/import')({
  staticData: { subtitle: 'Import FHIR records from a captured browsing session.' },
  component: ImporterScreen,
})

export { Route }

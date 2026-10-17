import { createFileRoute } from '@tanstack/react-router'

import { enterInteractions, InteractionsTab } from '../../-tabs/interactions/interactions-tab.tsx'

/** `/patients/$patientId/interactions`, the patient's Interactions tab. */
const Route = createFileRoute('/patients/$patientId/interactions')({
  onEnter: ({ context }) => {
    enterInteractions(context)
  },
  component: InteractionsTab,
})

export { Route }

import { createFileRoute } from '@tanstack/react-router'

import { enterInteractions, InteractionsTab } from '../-tabs/interactions/interactions-tab.tsx'

/** `/interactions`, every patient's Interactions tab. */
const Route = createFileRoute('/_all-patients/interactions')({
  onEnter: ({ context }) => {
    enterInteractions(context)
  },
  component: InteractionsTab,
})

export { Route }

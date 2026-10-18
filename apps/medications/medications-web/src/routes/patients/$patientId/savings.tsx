import { createFileRoute } from '@tanstack/react-router'

import { SavingsTab } from '../../-tabs/savings/savings-tab.tsx'

/** `/patients/$patientId/savings`, the patient's Savings tab. */
const Route = createFileRoute('/patients/$patientId/savings')({
  component: SavingsTab,
})

export { Route }
